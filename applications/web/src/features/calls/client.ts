import { z } from 'zod';

import { ClientError, errorMessage, retryAfter } from '../../shared/api/client';
import { pwaSupported } from '../../shared/pwa';
import { prepareUpdate, updateChannel, updateLock, updateRequested } from '../../shared/pwa-update';
import { pushConfig, syncWebPush } from '../../shared/web-push';
import { identity, logout, readSession, saveSession } from '../auth/session';
import type { Call } from './protocol';
import {
  callResponse,
  callSchema,
  currentResponse,
  iceConfig,
  iceMessage,
  mergeCall,
  pingResponse,
  sdpMessage,
} from './protocol';
import { Signaling } from './signaling';

export interface ClientState {
  owner: boolean;
  connection: 'offline' | 'connecting' | 'online';
  call: Call | null;
  selected: boolean;
  muted: boolean;
  busy: boolean;
  error: string | null;
  audioBlocked: boolean;
  audible: boolean;
  media: string;
  stats: { relay: boolean; sent: number; received: number };
}

const initial: ClientState = {
  owner: false,
  connection: 'offline',
  call: null,
  selected: false,
  muted: false,
  busy: false,
  error: null,
  audioBlocked: false,
  audible: false,
  media: 'new',
  stats: { relay: false, sent: 0, received: 0 },
};
const stateSchema = z.object({
  owner: z.boolean(),
  connection: z.enum(['offline', 'connecting', 'online']),
  call: callSchema.nullable(),
  selected: z.boolean(),
  muted: z.boolean(),
  busy: z.boolean(),
  error: z.string().nullable(),
  audioBlocked: z.boolean(),
  audible: z.boolean(),
  media: z.string(),
  stats: z.object({ relay: z.boolean(), sent: z.number(), received: z.number() }),
});

export class GChatClient {
  private state: ClientState = initial;
  private listeners = new Set<() => void>();
  private channel: BroadcastChannel | null = null;
  private sid: string | null = null;
  private lockAbort?: AbortController;
  private release?: () => void;
  private stopped = false;
  private transport: Signaling;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private statsTimer?: ReturnType<typeof setInterval>;
  private iceRefresh?: ReturnType<typeof setTimeout>;
  private ringtone?: ReturnType<typeof setInterval>;
  private audioContext?: AudioContext;
  private stream?: MediaStream;
  private mediaEpoch = 0;
  private pc?: RTCPeerConnection;
  private audio?: HTMLAudioElement;
  private negotiation: string | null = null;
  private knownNegotiations = new Set<string>();
  private localIce: object[] = [];
  private descriptionSent = false;
  private candidates = new Map<string, (RTCIceCandidateInit | null)[]>();
  private mediaQueue: Promise<void> = Promise.resolve();
  private events: Promise<void> = Promise.resolve();
  private connectedAttempt: string | null = null;
  private sequence = 0;
  private pingRunning = false;
  private connectionGeneration = 0;
  private retryCount = 0;
  private updatePending = false;
  private hydrated = false;

  private prepareFrontendUpdate = (): void => {
    this.updatePending = true;
    this.yieldForUpdate();
  };

  private yieldForUpdate(): void {
    if (
      this.updatePending &&
      this.state.owner &&
      this.hydrated &&
      !this.state.busy &&
      (!this.state.call || this.state.call.state === 'ended')
    ) {
      this.stopConnection();
      this.set({ owner: false, connection: 'offline' });
      this.release?.();
    }
  }

  constructor() {
    this.transport = new Signaling(
      (type, payload): void => {
        this.events = this.events
          .then((): Promise<void> => this.event(type, payload))
          .catch((cause: unknown): void => this.fail(cause));
      },
      (code): void => this.disconnected(code),
    );
  }

  getSnapshot = (): ClientState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return (): void => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch };

    for (const listener of this.listeners) listener();

    if (this.state.owner) this.channel?.postMessage({ type: 'state', state: this.state });

    this.yieldForUpdate();
  }

  start(): () => void {
    this.stopped = false;
    const updates = new BroadcastChannel(updateChannel);

    updates.onmessage = (event: MessageEvent<unknown>): void => {
      if (event.data === 'prepare') this.prepareFrontendUpdate();
    };
    const finished = (): void => {
      this.updatePending = false;
    };

    window.addEventListener(prepareUpdate, this.prepareFrontendUpdate);
    window.addEventListener('gchat-update-finished', finished);
    const updateMonitor = setInterval((): void => {
      if (this.updatePending)
        void updateRequested()
          .then((pending): void => {
            if (!pending) this.updatePending = false;
          })
          .catch((): void => {});
    }, 1000);

    this.channel = new BroadcastChannel('gchat-client');
    this.channel.onmessage = (event: MessageEvent<unknown>): void => {
      const message = event.data;

      if (!message || typeof message !== 'object' || !('type' in message)) return;

      if (message.type === 'state' && !this.state.owner && 'state' in message) {
        const parsed = stateSchema.safeParse(message.state);

        if (parsed.success) this.set({ ...parsed.data, owner: false, selected: false });
      }

      if (message.type === 'snapshot' && this.state.owner)
        this.channel?.postMessage({ type: 'state', state: this.state });

      if (
        message.type === 'takeover' &&
        this.state.owner &&
        (!this.state.call || this.state.call.state === 'ended')
      )
        this.release?.();
    };
    const sync = (): void => this.syncSession();

    window.addEventListener('storage', sync);
    window.addEventListener('gchat-session', sync);
    window.addEventListener('pagehide', this.unload);
    this.syncSession();
    this.channel.postMessage({ type: 'snapshot' });

    return (): void => {
      this.stopped = true;
      updates.close();
      clearInterval(updateMonitor);
      window.removeEventListener(prepareUpdate, this.prepareFrontendUpdate);
      window.removeEventListener('gchat-update-finished', finished);
      this.lockAbort?.abort();
      this.release?.();
      this.stopConnection();
      this.channel?.close();
      window.removeEventListener('storage', sync);
      window.removeEventListener('gchat-session', sync);
      window.removeEventListener('pagehide', this.unload);
    };
  }

  private unload = (): void => {
    this.release?.();
    this.stopConnection();
  };

  private syncSession(): void {
    const session = readSession();
    const sid = session ? identity(session).sid : null;

    if (sid === this.sid) return;

    this.sid = sid;
    this.lockAbort?.abort();
    this.release?.();
    this.stopConnection();
    this.set({ ...initial, audible: this.audioContext?.state === 'running' });

    if (sid) this.elect(sid);
  }

  private elect(sid: string): void {
    if (this.stopped || this.sid !== sid) return;

    const controller = new AbortController();

    this.lockAbort = controller;
    void navigator.locks
      .request('gchat-ws-owner', { signal: controller.signal }, async (): Promise<void> => {
        if (this.stopped || this.sid !== sid) return;

        await navigator.locks.request(
          updateLock,
          { mode: 'shared', signal: controller.signal },
          async (): Promise<void> => {
            if (this.stopped || this.sid !== sid) return;

            this.updatePending = false;
            this.hydrated = false;
            // Install the release function before any asynchronous connection work.
            const lifetime = new Promise<void>((resolve): void => {
              this.release = resolve;
            });

            this.set({ owner: true });
            void this.connect();
            await lifetime;
            this.release = undefined;
            this.stopConnection();
            this.set({ owner: false, connection: 'offline', selected: false });
          },
        );
      })
      .catch((): void => {})
      .finally((): void => {
        if (!this.stopped && this.sid === sid && !controller.signal.aborted)
          setTimeout((): void => this.elect(sid), 250);
      });
  }

  activate(): void {
    this.channel?.postMessage({ type: 'takeover' });
  }

  webPush(type: 'device.web_push_config' | 'device.web_push', payload: object): Promise<unknown> {
    if (
      !this.state.owner ||
      this.state.connection !== 'online' ||
      !readSession() ||
      identity(readSession()!).sid !== this.sid
    )
      return Promise.reject(
        new Error('Откройте GChat в основной вкладке и дождитесь подключения.'),
      );

    return this.transport.send(type, payload);
  }

  private async connect(): Promise<void> {
    if (!this.state.owner || !readSession()) return;

    const generation = ++this.connectionGeneration;

    this.hydrated = false;

    this.set({ connection: 'connecting' });

    try {
      await this.transport.open();

      if (generation !== this.connectionGeneration) return;

      const registered = z.object({ device_id: z.string() }).parse(
        await this.transport.send('device.register', {
          device_id: readSession()?.deviceId ?? null,
        }),
      );
      const session = readSession();

      if (!session || identity(session).sid !== this.sid) return;

      saveSession({ ...session, deviceId: registered.device_id });
      this.set({ connection: 'online', error: null });
      this.retryCount = 0;

      // Rebind existing consent after login/reconnect; never request permission automatically.
      if (
        pwaSupported() &&
        'PushManager' in window &&
        'Notification' in window &&
        Notification.permission === 'granted'
      ) {
        void (async (): Promise<void> => {
          const config = pushConfig.parse(await this.webPush('device.web_push_config', {}));

          if (!config.public_key || generation !== this.connectionGeneration) return;

          await syncWebPush(
            config.public_key,
            (): boolean => generation === this.connectionGeneration && this.state.owner,
            (subscription): Promise<unknown> => this.webPush('device.web_push', { subscription }),
          );
        })().catch((cause: unknown): void => {
          if (generation === this.connectionGeneration) this.fail(cause);
        });
      }

      const current = currentResponse.parse(await this.transport.send('call.current', {})).call;

      if (generation !== this.connectionGeneration) return;

      if (current) {
        await this.update(current);

        if (current.state !== 'ringing' && current.state !== 'ended') await this.restoreMedia();
      } else {
        this.disposeMedia();
        this.set({ call: null, selected: false });
      }

      this.hydrated = true;
      this.yieldForUpdate();
    } catch (cause) {
      if (generation !== this.connectionGeneration) return;

      this.fail(cause);
      this.scheduleReconnect(retryAfter(cause));
    }
  }

  private disconnected(code: number): void {
    this.set({ connection: 'offline' });
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;

    if (code === 1008) this.disposeMedia();

    if (this.state.owner && readSession()) this.scheduleReconnect();
  }

  private scheduleReconnect(seconds = 0): void {
    clearTimeout(this.retry);

    if (!this.state.owner || !readSession()) return;

    this.retry = setTimeout(
      (): void => {
        void this.connect();
      },
      Math.max(seconds * 1000, Math.min(10000, 1000 * 2 ** Math.min(4, this.retryCount++))),
    );
  }

  private controlKey(): string {
    return 'gchat.control.' + this.sid;
  }

  private remember(id: string): void {
    localStorage.setItem(this.controlKey(), id);
    this.set({ selected: true });
  }

  private async update(call: Call): Promise<void> {
    const previous = this.state.call;
    const next = mergeCall(previous, call);

    if (previous && previous.call_id === next.call_id && next.version < previous.version) return;

    if (previous?.call_id !== next.call_id) {
      if (previous) this.disposeMedia();

      this.sequence = Number(localStorage.getItem('gchat.sequence.' + next.call_id) ?? 0);
    }

    const selected = localStorage.getItem(this.controlKey()) === next.call_id;

    this.set({ call: next, selected });

    if (next.state === 'ringing' && !this.isCaller() && this.audioContext?.state === 'running') {
      if (!this.ringtone) {
        this.tone();
        this.ringtone = setInterval((): void => this.tone(), 3000);
      }
    } else {
      clearInterval(this.ringtone);
      this.ringtone = undefined;
    }

    if (next.state === 'ended') {
      this.disposeMedia();
      localStorage.removeItem(this.controlKey());
      localStorage.removeItem('gchat.sequence.' + next.call_id);
      this.set({ selected: false });

      return;
    }

    if (selected && next.state !== 'ringing') {
      this.startHeartbeat();

      if (!this.pc && this.stream) await this.queueMedia((): Promise<void> => this.negotiate());
    }
  }

  private async event(type: string, payload: unknown): Promise<void> {
    if (!this.state.owner) return;

    if (type === 'call.updated') {
      const call = callResponse.parse(payload).call;

      if (this.state.call?.call_id !== call.call_id) {
        const current = currentResponse.parse(await this.transport.send('call.current', {})).call;

        if (current) await this.update(current);
      } else await this.update(call);

      return;
    }

    await this.queueMedia(async (): Promise<void> => {
      const call = this.state.call;

      if (!call || call.state === 'ended') return;

      if (!this.state.selected) {
        try {
          await this.transport.send('call.ice_config', { call_id: call.call_id });
          this.remember(call.call_id);
          await this.microphone();
          this.startHeartbeat();
        } catch {
          return;
        }
      }

      if (type === 'rtc.restart') {
        if (this.isCaller()) await this.negotiate();

        return;
      }

      if (type === 'rtc.offer') {
        const input = sdpMessage.parse(payload);

        if (input.call_id !== call.call_id || this.isCaller()) return;

        if (
          this.negotiation &&
          this.negotiation !== input.negotiation_id &&
          this.knownNegotiations.has(input.negotiation_id)
        )
          return;

        await this.ensurePeer();
        this.negotiation = input.negotiation_id;
        this.descriptionSent = false;
        this.localIce = [];
        this.knownNegotiations.add(input.negotiation_id);
        this.connectedAttempt = null;
        await this.pc!.setRemoteDescription({ type: 'offer', sdp: input.sdp });
        await this.flushCandidates();
        const answer = await this.pc!.createAnswer();

        await this.pc!.setLocalDescription(answer);
        await this.transport.send('rtc.answer', {
          call_id: call.call_id,
          negotiation_id: this.negotiation,
          sdp: answer.sdp,
        });
        await this.flushLocalIce();
        await this.confirm();
      } else if (type === 'rtc.answer') {
        const input = sdpMessage.parse(payload);

        if (input.call_id !== call.call_id || input.negotiation_id !== this.negotiation || !this.pc)
          return;

        if (this.pc.signalingState === 'have-local-offer')
          await this.pc.setRemoteDescription({ type: 'answer', sdp: input.sdp });

        await this.flushCandidates();
        await this.confirm();
      } else if (type === 'rtc.ice') {
        const input = iceMessage.parse(payload);

        if (input.call_id !== call.call_id) return;

        const candidate = input.candidate
          ? {
              candidate: input.candidate.candidate,
              sdpMid: input.candidate.sdp_mid,
              sdpMLineIndex: input.candidate.sdp_mline_index,
            }
          : null;

        if (input.negotiation_id === this.negotiation && this.pc?.remoteDescription) {
          if (candidate) await this.pc.addIceCandidate(candidate);
        } else {
          const items = this.candidates.get(input.negotiation_id) ?? [];

          if (items.length < 128) items.push(candidate);

          this.candidates.set(input.negotiation_id, items);
        }
      }
    });
  }

  private queueMedia(action: () => Promise<void>): Promise<void> {
    const next = this.mediaQueue.then(action);

    this.mediaQueue = next.catch((): void => {});

    return next;
  }

  private isCaller(): boolean {
    const session = readSession();

    return !!session && this.state.call?.caller_id === identity(session).sub;
  }

  private async microphone(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error('Для микрофона нужен HTTPS или localhost.');

    if (this.stream) return;

    const epoch = this.mediaEpoch;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });

    if (epoch !== this.mediaEpoch) {
      for (const track of stream.getTracks()) track.stop();

      throw new ClientError('CANCELLED', 'Действие отменено');
    }

    this.stream = stream;
  }

  private async ensurePeer(): Promise<void> {
    if (this.pc && this.pc.connectionState !== 'closed') return;

    const epoch = this.mediaEpoch;

    await this.microphone();
    const call = this.state.call;

    if (!call || call.state === 'ended') return;

    const config = iceConfig.parse(
      await this.transport.send('call.ice_config', { call_id: call.call_id }),
    );

    if (
      epoch !== this.mediaEpoch ||
      this.state.call?.call_id !== call.call_id ||
      this.state.call.state === 'ended'
    )
      return;

    const pc = new RTCPeerConnection({
      iceServers: config.ice_servers,
      iceTransportPolicy: 'relay',
    });

    this.pc = pc;

    for (const track of this.stream!.getTracks()) pc.addTrack(track, this.stream!);

    this.audio = new Audio();
    this.audio.autoplay = true;
    pc.ontrack = (event): void => {
      if (!this.audio) return;

      this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void this.playAudio();
    };
    pc.onicecandidate = (event): void => {
      if (!this.negotiation || pc !== this.pc || !this.state.call) return;

      const candidate = event.candidate;

      const payload = {
        call_id: call.call_id,
        negotiation_id: this.negotiation,
        candidate: candidate
          ? {
              candidate: candidate.candidate,
              sdp_mid: candidate.sdpMid,
              sdp_mline_index: candidate.sdpMLineIndex,
            }
          : null,
      };

      if (!this.descriptionSent) this.localIce.push(payload);
      else
        void this.transport
          .send('rtc.ice', payload)
          .catch((cause: unknown): void => this.fail(cause));
    };
    pc.onconnectionstatechange = (): void => {
      if (pc !== this.pc) return;

      this.set({ media: pc.connectionState });

      if (pc.connectionState === 'connected')
        void this.confirm().catch((cause: unknown): void => this.fail(cause));

      if (['failed', 'disconnected'].includes(pc.connectionState)) {
        void this.ping();
        void this.restart().catch((cause: unknown): void => this.fail(cause));
      }
    };
    this.statsTimer = setInterval((): void => {
      void this.collectStats().catch((): void => {});
    }, 1000);
    this.iceRefresh = setTimeout(
      (): void => {
        void this.refreshIce();
      },
      Math.max(1000, Date.parse(config.expires_at) - Date.now() - 60000),
    );
  }

  private async refreshIce(): Promise<void> {
    const call = this.state.call;

    if (!call || !this.pc) return;

    try {
      const config = iceConfig.parse(
        await this.transport.send('call.ice_config', { call_id: call.call_id }),
      );

      this.pc.setConfiguration({ iceServers: config.ice_servers, iceTransportPolicy: 'relay' });
      await this.restart();
      this.iceRefresh = setTimeout(
        (): void => {
          void this.refreshIce();
        },
        Math.max(1000, Date.parse(config.expires_at) - Date.now() - 60000),
      );
    } catch (cause) {
      this.fail(cause);
      this.iceRefresh = setTimeout((): void => {
        void this.refreshIce();
      }, 10000);
    }
  }

  private async negotiate(): Promise<void> {
    await this.ensurePeer();

    if (!this.isCaller() || !this.pc || !this.state.call || this.pc.signalingState !== 'stable')
      return;

    this.negotiation = crypto.randomUUID();
    this.descriptionSent = false;
    this.localIce = [];
    this.knownNegotiations.add(this.negotiation);
    this.connectedAttempt = null;
    const offer = await this.pc.createOffer({ iceRestart: this.pc.localDescription !== null });

    await this.pc.setLocalDescription(offer);
    await this.transport.send('rtc.offer', {
      call_id: this.state.call.call_id,
      negotiation_id: this.negotiation,
      sdp: offer.sdp,
    });
    await this.flushLocalIce();
    await this.confirm();
  }

  private async restart(): Promise<void> {
    if (this.state.connection !== 'online' || !this.state.selected || !this.state.call) return;

    if (this.isCaller()) await this.queueMedia((): Promise<void> => this.negotiate());
    else await this.transport.send('rtc.restart', { call_id: this.state.call.call_id });
  }

  private async restoreMedia(): Promise<void> {
    const call = this.state.call;

    if (!call) return;

    try {
      iceConfig.parse(await this.transport.send('call.ice_config', { call_id: call.call_id }));
      this.remember(call.call_id);
      await this.microphone();
      this.startHeartbeat();
      await this.restart();
    } catch (cause) {
      if (!(cause instanceof ClientError && cause.code === 'FORBIDDEN')) this.fail(cause);
    }
  }

  private async flushLocalIce(): Promise<void> {
    this.descriptionSent = true;
    const queued = this.localIce;

    this.localIce = [];

    for (const payload of queued) await this.transport.send('rtc.ice', payload);
  }

  private async flushCandidates(): Promise<void> {
    if (!this.pc || !this.negotiation) return;

    for (const candidate of this.candidates.get(this.negotiation) ?? [])
      if (candidate) await this.pc.addIceCandidate(candidate);

    this.candidates.delete(this.negotiation);
  }

  private async confirm(): Promise<void> {
    const call = this.state.call;

    if (
      !call ||
      !this.negotiation ||
      this.pc?.connectionState !== 'connected' ||
      this.connectedAttempt === this.negotiation
    )
      return;

    this.connectedAttempt = this.negotiation;

    try {
      await this.update(
        callResponse.parse(
          await this.transport.send('call.connected', {
            call_id: call.call_id,
            negotiation_id: this.negotiation,
          }),
        ).call,
      );
    } catch (cause) {
      this.connectedAttempt = null;

      throw cause;
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;

    this.heartbeat = setInterval((): void => {
      void this.ping();
    }, 10000);
    void this.ping();
  }

  private async ping(): Promise<void> {
    const call = this.state.call;

    if (
      this.pingRunning ||
      !this.state.selected ||
      !call ||
      !['connecting', 'active'].includes(call.state) ||
      this.state.connection !== 'online'
    )
      return;

    this.pingRunning = true;
    const sequence = ++this.sequence;

    localStorage.setItem('gchat.sequence.' + call.call_id, String(sequence));

    try {
      const result = pingResponse.parse(
        await this.transport.send('call.ping', {
          call_id: call.call_id,
          sequence,
          audio_connected: this.pc?.connectionState === 'connected',
          recovery_id: call.recovery_id,
        }),
      );
      const current = this.state.call;

      if (current?.call_id === call.call_id && result.version >= current.version)
        this.set({ call: { ...current, ...result } });
    } catch (cause) {
      this.fail(cause);
    } finally {
      this.pingRunning = false;
    }
  }

  private async collectStats(): Promise<void> {
    if (!this.pc) return;

    const stats = await this.pc.getStats();
    let sent = 0;
    let received = 0;
    let relay = false;

    stats.forEach((item): void => {
      if (item.type === 'outbound-rtp' && item.kind === 'audio')
        sent += Number(item.bytesSent ?? 0);

      if (item.type === 'inbound-rtp' && item.kind === 'audio')
        received += Number(item.bytesReceived ?? 0);

      if (item.type === 'transport' && item.selectedCandidatePairId) {
        const pair = stats.get(item.selectedCandidatePairId);

        if (pair) {
          const local = stats.get(pair.localCandidateId);

          relay = local?.candidateType === 'relay';
        }
      }
    });
    this.set({ stats: { sent, received, relay } });
  }

  async enableRingtone(): Promise<void> {
    try {
      this.audioContext ??= new AudioContext();
      await this.audioContext.resume();
      this.set({ audible: this.audioContext.state === 'running' });

      if (this.state.call?.state === 'ringing' && !this.isCaller() && !this.ringtone) {
        this.tone();
        this.ringtone = setInterval((): void => this.tone(), 3000);
      }
    } catch {
      this.set({ audible: false });
    }
  }

  private tone(): void {
    const context = this.audioContext;

    if (!context || context.state !== 'running') return;

    for (const frequency of [440, 480]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, context.currentTime);
      gain.gain.linearRampToValueAtTime(0.03, context.currentTime + 0.05);
      gain.gain.setValueAtTime(0.03, context.currentTime + 0.7);
      gain.gain.linearRampToValueAtTime(0, context.currentTime + 0.9);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 1);
      oscillator.onended = (): void => {
        oscillator.disconnect();
        gain.disconnect();
      };
    }
  }

  async playAudio(): Promise<void> {
    try {
      await this.audio?.play();
      this.set({ audioBlocked: false });
    } catch {
      this.set({ audioBlocked: true });
    }
  }

  mute(): void {
    const muted = !this.state.muted;

    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;

    this.set({ muted });
  }

  clearError(): void {
    this.set({ error: null });
  }

  dismiss(): void {
    if (this.state.call?.state === 'ended') this.set({ call: null });
  }

  async dial(recipientId: string): Promise<void> {
    if (this.updatePending) return;

    await this.action(async (): Promise<void> => {
      await this.microphone();
      const call = callResponse.parse(
        await this.transport.send('call.create', { recipient_id: recipientId }),
      ).call;

      this.remember(call.call_id);
      await this.update(call);
    });
  }

  async accept(): Promise<void> {
    await this.action(async (): Promise<void> => {
      const call = this.state.call;

      if (!call) return;

      await this.microphone();
      const accepted = callResponse.parse(
        await this.transport.send('call.accept', { call_id: call.call_id }),
      ).call;

      this.remember(call.call_id);
      await this.update(accepted);
      await this.ensurePeer();
    });
  }

  async end(reject = false): Promise<void> {
    await this.action(async (): Promise<void> => {
      const call = this.state.call;

      if (!call || call.state === 'ended') return;

      const type = reject ? 'call.reject' : call.state === 'ringing' ? 'call.cancel' : 'call.end';

      await this.update(
        callResponse.parse(await this.transport.send(type, { call_id: call.call_id })).call,
      );
    });
  }

  async signOut(): Promise<void> {
    if (this.state.call && this.state.call.state !== 'ended' && this.state.selected)
      await this.end();

    await logout();
  }

  private async action(action: () => Promise<void>): Promise<void> {
    if (!this.state.owner || this.state.connection !== 'online' || this.state.busy) return;

    this.set({ busy: true, error: null });

    try {
      await action();
    } catch (cause) {
      this.fail(cause);

      if (!this.state.selected) this.disposeMedia();

      if (this.state.connection === 'online') {
        try {
          const current = currentResponse.parse(await this.transport.send('call.current', {})).call;

          if (current) await this.update(current);
        } catch {
          // Keep the update barrier until reconnect resolves the unknown command outcome.
          this.hydrated = false;
          this.scheduleReconnect();
        }
      }
    } finally {
      this.set({ busy: false });
    }
  }

  private fail(cause: unknown): void {
    if (cause instanceof ClientError && cause.code === 'CANCELLED') return;

    this.set({
      error: errorMessage(cause, 'Действие не выполнено. Попробуйте ещё раз.'),
    });
  }

  private disposeMedia(): void {
    this.mediaEpoch++;
    clearInterval(this.ringtone);
    this.ringtone = undefined;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    clearInterval(this.statsTimer);
    clearTimeout(this.iceRefresh);

    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.close();
      this.pc = undefined;
    }

    for (const track of this.stream?.getTracks() ?? []) track.stop();

    this.stream = undefined;

    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
      this.audio = undefined;
    }

    this.negotiation = null;
    this.connectedAttempt = null;
    this.candidates.clear();
    this.knownNegotiations.clear();
    this.localIce = [];
    this.descriptionSent = false;
    this.set({
      muted: false,
      media: 'new',
      audioBlocked: false,
      stats: { sent: 0, received: 0, relay: false },
    });
  }

  private stopConnection(): void {
    this.connectionGeneration++;
    clearTimeout(this.retry);
    this.transport.close();
    this.disposeMedia();
  }
}
