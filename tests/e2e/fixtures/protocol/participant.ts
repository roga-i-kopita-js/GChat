// Independent reference endpoint: no imports from the production client or its state machine.
type Call = {
  call_id: string;
  state: 'ringing' | 'connecting' | 'active' | 'ended';
  version: number;
  started_at: string | null;
  end_reason: string | null;
  recovery_id: string | null;
  recovery_deadline: string | null;
  ringing_deadline: string | null;
  connecting_deadline: string | null;
};
type Envelope = {
  type: string;
  request_id?: string;
  payload: any;
  error?: { code: string };
};
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

class Participant {
  userId = '';
  deviceId: string | null = null;
  calls = new Map<string, Call>();
  events: Envelope[] = [];
  errors: string[] = [];
  commands: string[] = [];
  private access = '';
  private refresh = '';
  private socket?: WebSocket;
  private pending = new Map<string, Pending>();
  private sequence = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private peers: RTCPeerConnection[] = [];
  private contexts: AudioContext[] = [];
  private streams: MediaStream[] = [];
  private pc?: RTCPeerConnection;
  private audio?: AudioContext;
  private source?: MediaStream;
  private analyser?: AnalyserNode;
  private output?: HTMLAudioElement;
  private negotiation = '';
  private callId = '';
  private remoteIce: RTCIceCandidateInit[] = [];
  private localIce: (RTCIceCandidateInit | null)[] = [];
  private iceReady = false;
  private iceWork = Promise.resolve();
  private dropType?: string;

  async login(login: string): Promise<void> {
    const tokens = await this.http('/auth/login', { login, password: 'gchat-web-test-password' });

    this.access = tokens.access_token;
    this.refresh = tokens.refresh_token;
    this.userId = JSON.parse(
      atob(this.access.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')),
    ).sub;
    await this.reconnect();
    this.timer = setInterval((): void => {
      for (const call of this.calls.values()) {
        if (
          call.call_id === this.callId &&
          ['connecting', 'active'].includes(call.state) &&
          this.socket?.readyState === WebSocket.OPEN
        ) {
          void this.heartbeat(call.call_id);
        }
      }
    }, 2000);
  }

  private async heartbeat(callId: string): Promise<void> {
    try {
      await this.ping(callId);
    } catch (error) {
      // A deadline can win after the last full DTO but before this ping.
      if ((error as Error).message === 'CALL_STATE_CONFLICT') {
        try {
          const { call } = await this.request('call.get', { call_id: callId });

          if (call.state === 'ended') {
            return;
          }
        } catch {
          /* Preserve the original failure below. */
        }
      }

      this.errors.push((error as Error).message);
    }
  }

  private async http(path: string, body: object): Promise<any> {
    const response = await fetch('/api' + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.access ? { Authorization: 'Bearer ' + this.access } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error('HTTP_' + response.status);
    }

    return response.status === 204 ? undefined : response.json();
  }

  async reconnect(): Promise<void> {
    const { ticket } = await this.http('/auth/ws-ticket', {});
    const socket = new WebSocket(location.origin.replace('http', 'ws') + '/ws', [
      'gchat',
      'ticket.' + ticket,
    ]);

    this.socket = socket;
    socket.onmessage = (message): void => {
      const envelope: Envelope = JSON.parse(message.data);
      const call = envelope.payload?.call as Call | undefined;

      if (call) {
        this.remember(call);
      }

      if (envelope.type === 'response') {
        const pending = this.pending.get(envelope.request_id!);

        if (!pending) {
          return;
        }

        this.pending.delete(envelope.request_id!);

        if (envelope.error) {
          pending.reject(new Error(envelope.error.code));
        } else {
          pending.resolve(envelope.payload);
        }
      } else {
        this.events.push(envelope);

        if (envelope.type === 'rtc.ice' && envelope.payload.negotiation_id === this.negotiation) {
          const candidate = envelope.payload.candidate;

          if (candidate) {
            const ice = {
              candidate: candidate.candidate,
              sdpMid: candidate.sdp_mid,
              sdpMLineIndex: candidate.sdp_mline_index,
            };

            if (this.pc?.remoteDescription) {
              void this.pc.addIceCandidate(ice).catch((error: Error): void => {
                this.errors.push(error.message);
              });
            } else {
              this.remoteIce.push(ice);
            }
          }
        }
      }
    };
    socket.onclose = (event): void => {
      if (event.code === 1008) {
        this.closeMedia();
      }

      for (const pending of this.pending.values()) {
        pending.reject(new Error('SOCKET_CLOSED'));
      }

      this.pending.clear();
    };
    await new Promise<void>((resolve, reject): void => {
      socket.onopen = (): void => {
        resolve();
      };
      socket.onerror = (): void => {
        reject(new Error('SOCKET_OPEN_FAILED'));
      };
    });
    const result = await this.request('device.register', { device_id: this.deviceId });

    this.deviceId = result.device_id;
    await this.request('call.current', {});
  }

  private remember(call: Call): void {
    const previous = this.calls.get(call.call_id);

    if (previous && previous.version > call.version) {
      return;
    }

    this.calls.set(call.call_id, call);

    if (call.state === 'ended' && this.callId === call.call_id) {
      this.closeMedia();
    }
  }

  async request(type: string, payload: object): Promise<any> {
    const requestId = crypto.randomUUID();

    this.commands.push(type);
    const result = new Promise<any>((resolve, reject): void => {
      const timeout = setTimeout((): void => {
        this.pending.delete(requestId);
        reject(new Error('UNKNOWN_RESULT'));
      }, 8000);

      this.pending.set(requestId, {
        resolve: (value): void => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error): void => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });

    if (this.dropType === type) {
      this.dropType = undefined;
      // Send a real command, discard only its response to model an unknown outcome.
      const pending = this.pending.get(requestId)!;

      this.pending.delete(requestId);
      this.socket!.send(JSON.stringify({ type, request_id: requestId, payload }));
      pending.reject(new Error('UNKNOWN_RESULT'));
    } else {
      this.socket!.send(JSON.stringify({ type, request_id: requestId, payload }));
    }

    return result;
  }

  dropNextResponse(type: string): void {
    this.dropType = type;
  }

  async ping(
    callId: string,
    audioConnected = this.pc?.connectionState === 'connected',
  ): Promise<any> {
    const sequence = (this.sequence.get(callId) ?? 0) + 1;

    this.sequence.set(callId, sequence);
    const result = await this.request('call.ping', {
      call_id: callId,
      sequence,
      audio_connected: audioConnected,
      recovery_id: this.calls.get(callId)?.recovery_id ?? null,
    });

    // A compact response can precede its full state event. Read a coherent DTO.
    await this.request('call.get', { call_id: callId });

    return result;
  }

  async prepare(callId: string, frequency: number, unavailableTurn = false): Promise<void> {
    this.closeMedia();
    this.callId = callId;
    const config = await this.request('call.ice_config', { call_id: callId });
    const pc = new RTCPeerConnection({
      iceTransportPolicy: 'relay',
      iceServers: unavailableTurn
        ? [
            {
              urls: 'turn:127.0.0.1:9?transport=udp',
              username: 'unavailable',
              credential: 'unavailable',
            },
          ]
        : config.ice_servers,
    });

    this.pc = pc;
    this.peers.push(pc);
    // Chromium's silent sink keeps the real-time graph independent of host speakers.
    // sinkId is not in the workspace's TypeScript DOM declarations yet.
    const audioOptions: AudioContextOptions & { sinkId: { type: 'none' } } = {
      sampleRate: 48000,
      sinkId: { type: 'none' },
    };

    this.audio = new AudioContext(audioOptions);
    this.contexts.push(this.audio);
    await this.audio.resume();
    const tone = this.audio.createOscillator();
    const gain = this.audio.createGain();
    const destination = this.audio.createMediaStreamDestination();

    tone.frequency.value = frequency;
    gain.gain.value = 0.2;
    tone.connect(gain).connect(destination);
    tone.start();
    this.source = destination.stream;
    this.streams.push(destination.stream);

    for (const track of destination.stream.getTracks()) {
      pc.addTrack(track, destination.stream);
    }

    pc.ontrack = (event): void => {
      const stream = new MediaStream([event.track]);

      this.streams.push(stream);
      // Chromium needs the media renderer running before Web Audio consumes
      // a remote WebRTC stream. play() is asynchronous; creating the source
      // before it resolves races renderer initialization.
      const context = this.audio!;
      const output = new Audio();

      this.output = output;
      output.muted = true;
      output.srcObject = stream;
      void output
        .play()
        .then((): void => {
          // A late playback completion must not attach to an ended/replaced call.
          if (this.pc !== pc || pc.connectionState === 'closed' || this.audio !== context) {
            return;
          }

          this.analyser = context.createAnalyser();
          this.analyser.fftSize = 8192;
          context
            .createMediaStreamSource(stream)
            .connect(this.analyser)
            .connect(context.destination);
        })
        .catch((): void => {
          if (pc.connectionState !== 'closed') {
            this.errors.push('AUDIO_PLAY_FAILED');
          }
        });
    };
    this.localIce = [];
    this.remoteIce = [];
    this.iceReady = false;
    pc.onicecandidate = (event): void => {
      this.localIce.push(event.candidate?.toJSON() ?? null);

      if (this.iceReady) {
        this.flushIce();
      }
    };
  }

  private flushIce(): void {
    const candidates = this.localIce.splice(0);
    const negotiationId = this.negotiation;
    const callId = this.callId;

    this.iceWork = this.iceWork
      .then(async (): Promise<void> => {
        for (const candidate of candidates) {
          await this.request('rtc.ice', {
            call_id: callId,
            negotiation_id: negotiationId,
            candidate: candidate
              ? {
                  candidate: candidate.candidate,
                  sdp_mid: candidate.sdpMid,
                  sdp_mline_index: candidate.sdpMLineIndex,
                }
              : null,
          });
        }
      })
      .catch((error: Error): void => {
        this.errors.push(error.message);
      });
  }

  async offer(): Promise<string> {
    this.negotiation = crypto.randomUUID();
    await this.pc!.setLocalDescription(await this.pc!.createOffer());
    await this.request('rtc.offer', {
      call_id: this.callId,
      negotiation_id: this.negotiation,
      sdp: this.pc!.localDescription!.sdp,
    });
    this.iceReady = true;
    this.flushIce();

    return this.negotiation;
  }

  async answer(): Promise<string> {
    const offer = this.events.findLast(
      (event): boolean => event.type === 'rtc.offer' && event.payload.call_id === this.callId,
    )!;

    this.negotiation = offer.payload.negotiation_id;
    await this.pc!.setRemoteDescription({ type: 'offer', sdp: offer.payload.sdp });

    // Candidates may have arrived before the test driver selected this offer.
    for (const event of this.events) {
      if (
        event.type === 'rtc.ice' &&
        event.payload.negotiation_id === this.negotiation &&
        event.payload.candidate
      ) {
        const candidate = event.payload.candidate;

        await this.pc!.addIceCandidate({
          candidate: candidate.candidate,
          sdpMid: candidate.sdp_mid,
          sdpMLineIndex: candidate.sdp_mline_index,
        });
      }
    }

    await this.pc!.setLocalDescription(await this.pc!.createAnswer());
    await this.request('rtc.answer', {
      call_id: this.callId,
      negotiation_id: this.negotiation,
      sdp: this.pc!.localDescription!.sdp,
    });
    this.iceReady = true;
    this.flushIce();

    return this.negotiation;
  }

  async applyAnswer(): Promise<void> {
    const answer = this.events.findLast(
      (event): boolean =>
        event.type === 'rtc.answer' && event.payload.negotiation_id === this.negotiation,
    )!;

    await this.pc!.setRemoteDescription({ type: 'answer', sdp: answer.payload.sdp });

    for (const candidate of this.remoteIce.splice(0)) {
      await this.pc!.addIceCandidate(candidate);
    }
  }

  setTone(enabled: boolean): void {
    for (const track of this.source!.getAudioTracks()) {
      track.enabled = enabled;
    }
  }

  closeMedia(): void {
    this.pc?.close();

    for (const stream of this.streams) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }

    for (const context of this.contexts) {
      if (context.state !== 'closed') {
        void context.close();
      }
    }

    if (this.output) {
      this.output.pause();
      this.output.srcObject = null;
    }

    this.analyser = undefined;
  }

  async disconnectSocket(): Promise<void> {
    const socket = this.socket!;

    await new Promise<void>((resolve): void => {
      socket.addEventListener(
        'close',
        (): void => {
          resolve();
        },
        { once: true },
      );
      socket.close();
    });
  }

  async revoke(): Promise<void> {
    await this.http('/auth/logout', { refresh_token: this.refresh });
  }

  async snapshot(): Promise<any> {
    let peakHz = 0;
    let rms = 0;

    if (this.analyser) {
      const spectrum = new Float32Array(this.analyser.frequencyBinCount);
      const samples = new Float32Array(this.analyser.fftSize);

      this.analyser.getFloatFrequencyData(spectrum);
      this.analyser.getFloatTimeDomainData(samples);
      let peak = 0;

      for (let index = 1; index < spectrum.length; index++) {
        if (spectrum[index] > spectrum[peak]) {
          peak = index;
        }
      }

      peakHz = (peak * this.audio!.sampleRate) / this.analyser.fftSize;
      rms = Math.sqrt(
        samples.reduce((sum, value): number => sum + value * value, 0) / samples.length,
      );
    }

    const stats = await this.pc?.getStats();
    let sent = 0;
    let received = 0;
    let relay = false;
    let receivedEnergy = 0;
    let sourceEnergy = 0;

    stats?.forEach((stat): void => {
      if (stat.type === 'outbound-rtp' && stat.kind === 'audio') {
        sent += stat.bytesSent;
      }

      if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
        received += stat.bytesReceived;
        receivedEnergy += stat.totalAudioEnergy ?? 0;
      }

      if (stat.type === 'media-source' && stat.kind === 'audio') {
        sourceEnergy += stat.totalAudioEnergy ?? 0;
      }

      if (stat.type === 'transport' && stat.selectedCandidatePairId) {
        const pair = stats.get(stat.selectedCandidatePairId);

        relay =
          stats.get(pair.localCandidateId)?.candidateType === 'relay' &&
          stats.get(pair.remoteCandidateId)?.candidateType === 'relay';
      }
    });

    return {
      calls: [...this.calls.values()],
      connection: this.pc?.connectionState ?? null,
      negotiation: this.negotiation,
      peakHz,
      rms,
      sent,
      received,
      relay,
      livePeers: this.peers.filter((pc): boolean => pc.connectionState !== 'closed').length,
      liveTracks: this.streams
        .flatMap((stream): MediaStreamTrack[] => stream.getTracks())
        .filter((track): boolean => track.readyState === 'live').length,
      liveContexts: this.contexts.filter((context): boolean => context.state !== 'closed').length,
      audioState: this.audio?.state,
      audioSink: this.audio
        ? (this.audio as AudioContext & { sinkId: { type: string } }).sinkId?.type
        : undefined,
      outputPaused: this.output?.paused,
      analyserReady: !!this.analyser,
      audioTime: this.audio?.currentTime,
      receivedEnergy,
      sourceEnergy,
      socketOpen: this.socket?.readyState === WebSocket.OPEN,
      errors: this.errors,
      commands: this.commands,
    };
  }
}

declare global {
  interface Window {
    callActor: Participant;
  }
}
window.callActor = new Participant();

export {};
