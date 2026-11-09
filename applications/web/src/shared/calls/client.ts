import { z } from 'zod';

import { ClientError, errorMessage, retryAfter } from '../api/client';
import { DeviceError } from '../device/contract';
import { pwaSupported } from '../pwa';
import { browserTransport } from '../runtime/transport';
import { identity, logout, readSession } from '../session/session';
import { pushConfig, syncWebPush } from '../web-push';
import { audioError, AudioPreparation, canRouteContext } from './audio-preparation';
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
import { CallScreenWakeLock } from './screen-wake-lock';

export interface ClientState {
  owner: boolean;
  connection: 'offline' | 'connecting' | 'online';
  call: Call | null;
  selected: boolean;
  muted: boolean;
  busy: boolean;
  error: string | null;
  audioBlocked: boolean;
  screenWakeLockWarning: boolean;
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
  screenWakeLockWarning: false,
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
  screenWakeLockWarning: z.boolean().default(false),
  audible: z.boolean(),
  media: z.string(),
  stats: z.object({ relay: z.boolean(), sent: z.number(), received: z.number() }),
});

export class GChatClient {
  readonly audioPreparation = new AudioPreparation(
    (): boolean =>
      this.state.owner &&
      !this.state.busy &&
      (!this.state.call || this.state.call.state === 'ended'),
  );
  private outputId = '';
  private outputBlocked = false;

  testSound(): Promise<void> {
    return this.audioPreparation.sound(this.outputId);
  }

  async setAudioOutput(id: string): Promise<void> {
    if (
      !this.state.owner ||
      this.state.busy ||
      (this.state.call && this.state.call.state !== 'ended' && !this.state.selected)
    ) {
      throw new DeviceError('BUSY');
    }

    this.audioPreparation.stop();

    try {
      if (this.audio) {
        if (typeof this.audio.setSinkId !== 'function') {
          throw new DeviceError('UNSUPPORTED');
        }

        await this.audio.setSinkId(id);
      }

      if (this.audioContext) {
        if (!canRouteContext(this.audioContext)) {
          throw new DeviceError('UNSUPPORTED');
        }

        await this.audioContext.setSinkId(id);
      }

      this.outputId = id;
      this.outputBlocked = false;
    } catch (cause) {
      this.outputBlocked = true;
      this.audio?.pause();
      this.set({ audioBlocked: true });

      throw cause;
    }
  }

  private state: ClientState = initial;
  private listeners = new Set<() => void>();
  private lastFailure: unknown = null;
  private screenWakeLock = new CallScreenWakeLock((unavailable): void => {
    if (this.state.screenWakeLockWarning !== unavailable) {
      this.set({ screenWakeLockWarning: unavailable });
    }
  });

  getLastFailure(): unknown {
    return this.lastFailure;
  }

  private channel: BroadcastChannel | null = null;

  private get sid(): string | null {
    const session = readSession();

    return session ? identity(session).sid : null;
  }

  private transport = browserTransport;
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
  private hydrated = false;

  private get updatePending(): boolean {
    return this.transport.isUpdating();
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
    this.syncScreenWakeLock();

    if (
      !this.state.owner ||
      this.state.busy ||
      (this.state.call && this.state.call.state !== 'ended')
    ) {
      this.audioPreparation.stop();
    }

    for (const listener of this.listeners) {
      listener();
    }

    if (this.state.owner) {
      this.channel?.postMessage({ type: 'state', state: this.state });
    }

    this.transport.changed();
  }

  private syncScreenWakeLock(): void {
    const { owner, selected, call } = this.state;

    this.screenWakeLock.setCall(
      owner && selected && this.stream && call && call.state !== 'ended' ? call.call_id : null,
    );
  }

  start(): () => void {
    this.channel = new BroadcastChannel('gchat-client');
    this.channel.onmessage = (event: MessageEvent<unknown>): void => {
      const parsed = z
        .object({ type: z.literal('state'), state: stateSchema })
        .safeParse(event.data);

      if (parsed.success && !this.transport.getSnapshot().owner) {
        this.set({ ...parsed.data.state, owner: false, selected: false });
      }

      if (
        z.object({ type: z.literal('snapshot') }).safeParse(event.data).success &&
        this.state.owner
      ) {
        this.channel?.postMessage({ type: 'state', state: this.state });
      }
    };
    const protect = this.transport.protect(
      (): boolean =>
        this.hydrated &&
        !this.state.busy &&
        (!this.state.call || this.state.call.state === 'ended'),
    );
    let previousGeneration = -1;
    let previousSession = this.sid;
    const sync = (): void => {
      const connection = this.transport.getSnapshot();

      const sessionChanged = previousSession !== this.sid;

      if (previousGeneration !== connection.generation || sessionChanged) {
        previousGeneration = connection.generation;
        previousSession = this.sid;
        this.hydrated = false;
        this.stopConnection();

        if (sessionChanged || !this.sid) {
          this.set({ ...initial });
        }
      }

      this.set({ owner: connection.owner, connection: connection.status });

      if (connection.error) {
        this.fail(connection.error);
      }

      if (connection.owner && connection.status === 'online' && !this.hydrated) {
        void this.connect();
      }
    };
    const unsubscribe = this.transport.subscribe(sync);
    const events = this.transport.subscribeMessage((type, payload): void => {
      if (!type.startsWith('call.') && !type.startsWith('rtc.')) {
        return;
      }

      const generation = this.connectionGeneration;

      this.events = (async () => {
        try {
          await this.events;

          if (generation === this.connectionGeneration) {
            await this.event(type, payload);
          }
        } catch (cause) {
          return this.fail(cause);
        }
      })();
    });

    sync();
    this.channel.postMessage({ type: 'snapshot' });

    return (): void => {
      unsubscribe();
      events();
      protect();
      this.stopConnection();
      this.channel?.close();
    };
  }

  activate(): void {
    this.transport.activate();
  }

  webPush(type: 'device.web_push_config' | 'device.web_push', payload: object): Promise<unknown> {
    if (
      !this.state.owner ||
      this.state.connection !== 'online' ||
      !readSession() ||
      identity(readSession()!).sid !== this.sid
    ) {
      return Promise.reject(
        new Error('Откройте GChat в основной вкладке и дождитесь подключения.'),
      );
    }

    return this.transport.send(type, payload);
  }

  private async connect(): Promise<void> {
    if (!this.state.owner || !readSession()) {
      return;
    }

    const generation = ++this.connectionGeneration;

    this.hydrated = false;

    try {
      // Rebind existing consent after login/reconnect; never request permission automatically.
      if (
        pwaSupported() &&
        'PushManager' in window &&
        'Notification' in window &&
        Notification.permission === 'granted'
      ) {
        void (async () => {
          try {
            const config = pushConfig.parse(await this.webPush('device.web_push_config', {}));

            if (!config.public_key || generation !== this.connectionGeneration) {
              return;
            }

            await syncWebPush(
              config.public_key,
              (): boolean => generation === this.connectionGeneration && this.state.owner,
              (subscription): Promise<unknown> => this.webPush('device.web_push', { subscription }),
            );
          } catch (cause) {
            if (generation === this.connectionGeneration) {
              this.fail(cause);
            }
          }
        })();
      }

      const current = currentResponse.parse(await this.transport.send('call.current', {})).call;

      if (generation !== this.connectionGeneration) {
        return;
      }

      if (current) {
        await this.update(current);

        if (current.state !== 'ringing' && current.state !== 'ended') {
          await this.restoreMedia();
        }
      } else {
        this.disposeMedia();
        this.set({ call: null, selected: false });
      }

      this.hydrated = true;
      this.transport.changed();
    } catch (cause) {
      if (generation !== this.connectionGeneration) {
        return;
      }

      this.fail(cause);
      this.scheduleReconnect(retryAfter(cause));
    }
  }

  private scheduleReconnect(seconds = 0): void {
    this.transport.reconnect(seconds);
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

    if (previous && previous.call_id === next.call_id && next.version < previous.version) {
      return;
    }

    if (previous?.call_id !== next.call_id) {
      // Ended calls already released their media. dial() may have acquired a
      // fresh microphone for this call before its response/event arrives.
      if (previous && previous.state !== 'ended') {
        this.disposeMedia();
      }

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

      if (!this.pc && this.stream) {
        await this.queueMedia((): Promise<void> => this.negotiate());
      }
    }
  }

  private async event(type: string, payload: unknown): Promise<void> {
    if (!this.state.owner) {
      return;
    }

    if (type === 'call.updated') {
      const call = callResponse.parse(payload).call;

      if (this.state.call?.call_id !== call.call_id) {
        const current = currentResponse.parse(await this.transport.send('call.current', {})).call;

        if (current) {
          await this.update(current);
        }
      } else {
        await this.update(call);
      }

      return;
    }

    await this.queueMedia(async (): Promise<void> => {
      const call = this.state.call;

      if (!call || call.state === 'ended') {
        return;
      }

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
        if (this.isCaller()) {
          await this.negotiate();
        }

        return;
      }

      if (type === 'rtc.offer') {
        const input = sdpMessage.parse(payload);

        if (input.call_id !== call.call_id || this.isCaller()) {
          return;
        }

        if (
          this.negotiation &&
          this.negotiation !== input.negotiation_id &&
          this.knownNegotiations.has(input.negotiation_id)
        ) {
          return;
        }

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
        const { sdp: answerSdp } = answer;

        await this.transport.send('rtc.answer', {
          call_id: call.call_id,
          negotiation_id: this.negotiation,
          sdp: answerSdp,
        });
        await this.flushLocalIce();
        await this.confirm();
      } else if (type === 'rtc.answer') {
        const input = sdpMessage.parse(payload);

        if (
          input.call_id !== call.call_id ||
          input.negotiation_id !== this.negotiation ||
          !this.pc
        ) {
          return;
        }

        if (this.pc.signalingState === 'have-local-offer') {
          await this.pc.setRemoteDescription({ type: 'answer', sdp: input.sdp });
        }

        await this.flushCandidates();
        await this.confirm();
      } else if (type === 'rtc.ice') {
        const input = iceMessage.parse(payload);

        if (input.call_id !== call.call_id) {
          return;
        }

        const candidate = input.candidate
          ? {
              candidate: input.candidate.candidate,
              sdpMid: input.candidate.sdp_mid,
              sdpMLineIndex: input.candidate.sdp_mline_index,
            }
          : null;

        if (input.negotiation_id === this.negotiation && this.pc?.remoteDescription) {
          if (candidate) {
            await this.pc.addIceCandidate(candidate);
          }
        } else {
          const items = this.candidates.get(input.negotiation_id) ?? [];

          if (items.length < 128) {
            items.push(candidate);
          }

          this.candidates.set(input.negotiation_id, items);
        }
      }
    });
  }

  private queueMedia(action: () => Promise<void>): Promise<void> {
    const next = (async () => {
      await this.mediaQueue;

      return action();
    })();

    this.mediaQueue = (async () => {
      try {
        return await next;
      } catch (cause) {}
    })();

    return next;
  }

  private isCaller(): boolean {
    const session = readSession();

    return !!session && this.state.call?.caller_id === identity(session).sub;
  }

  private async microphone(): Promise<void> {
    this.audioPreparation.stop();

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Для микрофона нужен HTTPS или localhost.');
    }

    if (this.stream) {
      return;
    }

    const epoch = this.mediaEpoch;
    const stream = await (async () => {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false,
        });
      } catch (cause) {
        throw new Error(audioError(cause));
      }
    })();

    if (epoch !== this.mediaEpoch) {
      const { getTracks: streamGetTracks } = stream;

      for (const track of streamGetTracks.bind(stream)()) {
        track.stop();
      }

      throw new ClientError('CANCELLED', 'Действие отменено');
    }

    this.stream = stream;
    this.syncScreenWakeLock();
  }

  private async ensurePeer(): Promise<void> {
    if (this.pc && this.pc.connectionState !== 'closed') {
      return;
    }

    const epoch = this.mediaEpoch;

    await this.microphone();
    const call = this.state.call;

    if (!call || call.state === 'ended') {
      return;
    }

    const config = iceConfig.parse(
      await this.transport.send('call.ice_config', { call_id: call.call_id }),
    );

    if (
      epoch !== this.mediaEpoch ||
      this.state.call?.call_id !== call.call_id ||
      this.state.call.state === 'ended'
    ) {
      return;
    }

    const pc = new RTCPeerConnection({
      iceServers: config.ice_servers,
      iceTransportPolicy: 'relay',
    });

    this.pc = pc;

    for (const track of this.stream!.getTracks()) {
      pc.addTrack(track, this.stream!);
    }

    const audio = new Audio();

    this.audio = audio;

    if (this.outputId) {
      try {
        await audio.setSinkId(this.outputId);
      } catch {
        this.outputBlocked = true;
        this.set({
          audioBlocked: true,
          error: 'Аудиовыход недоступен. Выберите доступное устройство.',
        });
      }
    }

    if (epoch !== this.mediaEpoch || this.audio !== audio) {
      return;
    }

    this.audio.autoplay = true;
    pc.ontrack = (event): void => {
      if (!this.audio) {
        return;
      }

      this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void this.playAudio();
    };
    pc.onicecandidate = (event): void => {
      if (!this.negotiation || pc !== this.pc || !this.state.call) {
        return;
      }

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

      if (!this.descriptionSent) {
        this.localIce.push(payload);
      } else {
        void (async () => {
          try {
            return await this.transport.send('rtc.ice', payload);
          } catch (cause) {
            return this.fail(cause);
          }
        })();
      }
    };
    pc.onconnectionstatechange = (): void => {
      if (pc !== this.pc) {
        return;
      }

      this.set({ media: pc.connectionState });

      if (pc.connectionState === 'connected') {
        void (async () => {
          try {
            return await this.confirm();
          } catch (cause) {
            return this.fail(cause);
          }
        })();
      }

      if (['failed', 'disconnected'].includes(pc.connectionState)) {
        void this.ping();
        void (async () => {
          try {
            return await this.restart();
          } catch (cause) {
            return this.fail(cause);
          }
        })();
      }
    };
    this.statsTimer = setInterval((): void => {
      void (async () => {
        try {
          return await this.collectStats();
        } catch (cause) {}
      })();
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

    if (!call || !this.pc) {
      return;
    }

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

    if (!this.isCaller() || !this.pc || !this.state.call || this.pc.signalingState !== 'stable') {
      return;
    }

    this.negotiation = crypto.randomUUID();
    this.descriptionSent = false;
    this.localIce = [];
    this.knownNegotiations.add(this.negotiation);
    this.connectedAttempt = null;
    const offer = await this.pc.createOffer({ iceRestart: this.pc.localDescription !== null });

    await this.pc.setLocalDescription(offer);
    const { sdp: offerSdp } = offer;

    await this.transport.send('rtc.offer', {
      call_id: this.state.call.call_id,
      negotiation_id: this.negotiation,
      sdp: offerSdp,
    });
    await this.flushLocalIce();
    await this.confirm();
  }

  private async restart(): Promise<void> {
    if (this.state.connection !== 'online' || !this.state.selected || !this.state.call) {
      return;
    }

    if (this.isCaller()) {
      await this.queueMedia((): Promise<void> => this.negotiate());
    } else {
      await this.transport.send('rtc.restart', { call_id: this.state.call.call_id });
    }
  }

  private async restoreMedia(): Promise<void> {
    const call = this.state.call;

    if (!call) {
      return;
    }

    try {
      iceConfig.parse(await this.transport.send('call.ice_config', { call_id: call.call_id }));
      this.remember(call.call_id);
      await this.microphone();
      this.startHeartbeat();
      await this.restart();
    } catch (cause) {
      if (!(cause instanceof ClientError && cause.code === 'FORBIDDEN')) {
        this.fail(cause);
      }
    }
  }

  private async flushLocalIce(): Promise<void> {
    this.descriptionSent = true;
    const queued = this.localIce;

    this.localIce = [];

    for (const payload of queued) {
      await this.transport.send('rtc.ice', payload);
    }
  }

  private async flushCandidates(): Promise<void> {
    if (!this.pc || !this.negotiation) {
      return;
    }

    for (const candidate of this.candidates.get(this.negotiation) ?? []) {
      if (candidate) {
        await this.pc.addIceCandidate(candidate);
      }
    }

    this.candidates.delete(this.negotiation);
  }

  private async confirm(): Promise<void> {
    const call = this.state.call;

    if (
      !call ||
      !this.negotiation ||
      this.pc?.connectionState !== 'connected' ||
      this.connectedAttempt === this.negotiation
    ) {
      return;
    }

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
    if (this.heartbeat) {
      return;
    }

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
    ) {
      return;
    }

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

      if (current?.call_id === call.call_id && result.version >= current.version) {
        this.set({ call: { ...current, ...result } });
      }
    } catch (cause) {
      this.fail(cause);
    } finally {
      this.pingRunning = false;
    }
  }

  private async collectStats(): Promise<void> {
    if (!this.pc) {
      return;
    }

    const stats = await this.pc.getStats();
    let sent = 0;
    let received = 0;
    let relay = false;

    const { forEach: statsForEach } = stats;

    statsForEach.bind(stats)((item): void => {
      if (item.type === 'outbound-rtp' && item.kind === 'audio') {
        sent += Number(item.bytesSent ?? 0);
      }

      if (item.type === 'inbound-rtp' && item.kind === 'audio') {
        received += Number(item.bytesReceived ?? 0);
      }

      if (item.type === 'transport' && item.selectedCandidatePairId) {
        const { get: statsGet } = stats;
        const pair = statsGet.bind(stats)(item.selectedCandidatePairId);

        if (pair) {
          const { get: statsGet2 } = stats;
          const local = statsGet2.bind(stats)(pair.localCandidateId);

          relay = local?.candidateType === 'relay';
        }
      }
    });
    this.set({ stats: { sent, received, relay } });
  }

  async enableRingtone(): Promise<void> {
    try {
      this.audioContext ??= new AudioContext();
      this.audioContext.onstatechange = (): void => {
        this.set({ audible: this.audioContext?.state === 'running' });
      };
      await this.audioContext.resume();

      if (this.outputId && canRouteContext(this.audioContext)) {
        await this.audioContext.setSinkId(this.outputId);
      }

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

    if (!context || context.state !== 'running') {
      return;
    }

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
    if (this.outputBlocked) {
      this.set({ audioBlocked: true });

      return;
    }

    try {
      await this.audio?.play();
      this.set({ audioBlocked: false });
    } catch {
      this.set({ audioBlocked: true });
    }
  }

  mute(): void {
    const muted = !this.state.muted;

    for (const track of this.stream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }

    this.set({ muted });
  }

  clearError(): void {
    this.lastFailure = null;
    this.set({ error: null });
  }

  dismiss(): void {
    if (this.state.call?.state === 'ended') {
      this.set({ call: null });
    }
  }

  async dial(recipientId: string): Promise<void> {
    if (this.updatePending) {
      return;
    }

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

      if (!call) {
        return;
      }

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

      if (!call || call.state === 'ended') {
        return;
      }

      let typeValue;

      if (reject) {
        typeValue = 'call.reject';
      } else if (call.state === 'ringing') {
        typeValue = 'call.cancel';
      } else {
        typeValue = 'call.end';
      }

      const type = typeValue;

      await this.update(
        callResponse.parse(await this.transport.send(type, { call_id: call.call_id })).call,
      );
    });
  }

  async signOut(): Promise<void> {
    if (this.state.call && this.state.call.state !== 'ended' && this.state.selected) {
      await this.end();
    }

    await logout();
  }

  private async action(action: () => Promise<void>): Promise<void> {
    if (!this.state.owner || this.state.connection !== 'online' || this.state.busy) {
      return;
    }

    this.set({ busy: true, error: null });

    try {
      await action();
    } catch (cause) {
      this.fail(cause);

      if (!this.state.selected) {
        this.disposeMedia();
      }

      if (this.state.connection === 'online') {
        try {
          const current = currentResponse.parse(await this.transport.send('call.current', {})).call;

          if (current) {
            await this.update(current);
          }
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
    this.lastFailure = cause;

    if (cause instanceof ClientError && cause.code === 'CANCELLED') {
      return;
    }

    this.set({
      error: errorMessage(cause, 'Действие не выполнено. Попробуйте ещё раз.'),
    });
  }

  private disposeMedia(): void {
    this.audioPreparation.stop();
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

    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }

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
    this.disposeMedia();
  }
}
