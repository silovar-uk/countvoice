export class AudioStore {
  constructor(mediaElement = null) {
    this.context = null;
    this.buffers = new Map();
    this.clipData = new Map();
    this.mediaElement = mediaElement;
    this.mediaDestination = null;
    this.outputNode = null;
    this.masterGain = null;
    this.volume = 0.5;
    this.usingMediaBridge = false;
    this.contextListeners = new Set();
    this.mediaListeners = new Set();
    this.mediaBridgePaused = false;
    this.needsUserGestureReset = false;
    this.hardResetRequired = false;
    this.suppressMediaEvents = false;

    this.bindMediaElementEvents();
  }

  get state() {
    return this.context?.state ?? "closed";
  }

  onContextStateChange(listener) {
    this.contextListeners.add(listener);
    return () => this.contextListeners.delete(listener);
  }

  onMediaBridgeEvent(listener) {
    this.mediaListeners.add(listener);
    return () => this.mediaListeners.delete(listener);
  }

  bindMediaElementEvents() {
    if (!this.mediaElement) return;

    this.mediaElement.addEventListener("pause", () => {
      this.mediaBridgePaused = true;
      if (!this.suppressMediaEvents) this.emitMediaEvent("pause");
    });

    this.mediaElement.addEventListener("playing", () => {
      this.mediaBridgePaused = false;
      if (!this.suppressMediaEvents) this.emitMediaEvent("playing");
    });

    this.mediaElement.addEventListener("ended", () => {
      this.mediaBridgePaused = true;
      if (!this.suppressMediaEvents) this.emitMediaEvent("ended");
    });

    this.mediaElement.addEventListener("error", () => {
      this.mediaBridgePaused = true;
      if (!this.suppressMediaEvents) this.emitMediaEvent("error");
    });
  }

  emitContextState() {
    const detail = { state: this.state, usingMediaBridge: this.usingMediaBridge };
    for (const listener of this.contextListeners) {
      try { listener(detail); } catch { /* listener failures are isolated */ }
    }
  }

  emitMediaEvent(type) {
    const detail = { type, paused: Boolean(this.mediaElement?.paused), usingMediaBridge: this.usingMediaBridge };
    for (const listener of this.mediaListeners) {
      try { listener(detail); } catch { /* listener failures are isolated */ }
    }
  }

  markForUserGestureReset({ hard = false } = {}) {
    this.needsUserGestureReset = true;
    this.hardResetRequired ||= Boolean(hard);
  }

  clearUserGestureReset() {
    this.needsUserGestureReset = false;
    this.hardResetRequired = false;
  }

  beginContext() {
    const context = new AudioContext({ latencyHint: "interactive" });
    this.context = context;
    this.masterGain = context.createGain();
    this.masterGain.gain.value = this.volume;
    this.outputNode = context.destination;
    this.masterGain.connect(this.outputNode);
    this.mediaDestination = null;
    this.usingMediaBridge = false;
    this.mediaBridgePaused = true;
    context.addEventListener("statechange", () => {
      if (this.context === context) this.emitContextState();
    });
    this.emitContextState();
    return context;
  }

  async rehydrateBuffersFor(context = this.context) {
    if (!context || context.state === "closed") return;
    const decoded = new Map();

    for (const [key, bytes] of this.clipData.entries()) {
      const buffer = await context.decodeAudioData(bytes.slice(0));
      decoded.set(key, buffer);
    }

    if (this.context === context) this.buffers = decoded;
  }

  releaseMediaBridge() {
    const media = this.mediaElement;
    this.suppressMediaEvents = true;
    try {
      if (media && !media.paused) media.pause();
      if (media?.srcObject) media.srcObject = null;
    } catch { /* optional cleanup */ }
    this.suppressMediaEvents = false;

    this.mediaDestination = null;
    this.usingMediaBridge = false;
    this.mediaBridgePaused = true;
    if (this.context && this.masterGain && this.context.state !== "closed") {
      this.setOutputNode(this.context.destination);
    }
  }

  recreateContextForUserGesture() {
    const previous = this.context;
    this.releaseMediaBridge();
    this.context = null;
    this.masterGain = null;
    this.outputNode = null;
    this.buffers = new Map();

    // Do not await close(): on iOS, resume/play needs to happen while the tap is still active.
    if (previous && previous.state !== "closed") {
      try { previous.close().catch(() => {}); } catch { /* optional cleanup */ }
    }

    return this.beginContext();
  }

  setOutputNode(node) {
    if (!this.context || !this.masterGain) return false;
    const next = node ?? this.context.destination;
    try { this.masterGain.disconnect(); } catch { /* no existing route */ }
    try {
      this.masterGain.connect(next);
      this.outputNode = next;
      return true;
    } catch {
      try {
        this.masterGain.connect(this.context.destination);
        this.outputNode = this.context.destination;
      } catch { /* optional */ }
      return false;
    }
  }

  setVolume(value) {
    const parsed = Number(value);
    const next = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : this.volume;
    this.volume = next;

    if (this.masterGain && this.context) {
      const now = this.context.currentTime;
      try {
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setTargetAtTime(next, now, 0.012);
      } catch {
        this.masterGain.gain.value = next;
      }
    }

    return this.volume;
  }

  async ensureContext({ resume = true, preferMediaElement = false } = {}) {
    if (!this.context || this.context.state === "closed") {
      this.beginContext();
    }

    if (resume && this.context.state !== "running") {
      await this.context.resume();
    }

    if (preferMediaElement) {
      await this.enableMediaBridge();
    }

    return this.context;
  }

  primeOutput() {
    const context = this.context;
    if (!context || !this.masterGain || context.state !== "running") return;

    try {
      const source = context.createBufferSource();
      const gain = context.createGain();
      const buffer = context.createBuffer(1, 1, context.sampleRate);
      buffer.getChannelData(0)[0] = 0;
      gain.gain.value = 0;
      source.buffer = buffer;
      source.connect(gain).connect(this.masterGain);
      source.start(context.currentTime);
      source.stop(context.currentTime + 0.02);
    } catch { /* warm-up is best effort */ }
  }

  enableMediaBridge({ force = false } = {}) {
    if (!this.context || !this.mediaElement || typeof this.context.createMediaStreamDestination !== "function") {
      return Promise.resolve(false);
    }

    if (force) this.releaseMediaBridge();

    if (!this.mediaDestination) {
      this.mediaDestination = this.context.createMediaStreamDestination();
      this.mediaElement.srcObject = this.mediaDestination.stream;
      this.mediaElement.playsInline = true;
      this.mediaElement.preload = "auto";
      this.mediaElement.muted = false;
      this.mediaElement.defaultMuted = false;
      this.mediaElement.volume = 1;
    }

    this.setOutputNode(this.mediaDestination);

    // Call play immediately, before awaiting any buffer decoding, to keep iOS user activation.
    let playPromise;
    try { playPromise = this.mediaElement.play(); } catch { playPromise = Promise.reject(new Error("MEDIA_PLAY_FAILED")); }

    return Promise.resolve(playPromise)
      .then(() => {
        this.usingMediaBridge = true;
        this.mediaBridgePaused = false;
        this.primeOutput();
        return true;
      })
      .catch(() => {
        this.setOutputNode(this.context.destination);
        this.usingMediaBridge = false;
        this.mediaBridgePaused = true;
        return false;
      });
  }

  async resumeForUserGesture({ preferMediaElement = false, forceRecreate = false } = {}) {
    const mustRecreate = Boolean(forceRecreate || this.hardResetRequired);
    let context;

    if (mustRecreate) {
      context = this.recreateContextForUserGesture();
    } else if (!this.context || this.context.state === "closed") {
      context = this.beginContext();
    } else {
      context = this.context;
    }

    // Start the audio session immediately while the original button tap is still live.
    const resumePromise = context.state === "running" ? Promise.resolve() : context.resume();
    const bridgePromise = preferMediaElement
      ? this.enableMediaBridge({
        force: Boolean(mustRecreate || this.needsUserGestureReset || this.mediaBridgePaused || !this.usingMediaBridge),
      })
      : Promise.resolve(true);

    await resumePromise;

    if (!preferMediaElement) {
      if (this.usingMediaBridge || this.mediaDestination) this.releaseMediaBridge();
      this.setOutputNode(context.destination);
    }

    const bridgeReady = await bridgePromise;
    if (preferMediaElement && !bridgeReady) throw new Error("MEDIA_BRIDGE_NOT_READY");

    if (mustRecreate && this.clipData.size > 0) {
      await this.rehydrateBuffersFor(context);
    }

    this.primeOutput();

    if (context.state !== "running") {
      throw new Error(`AUDIO_CONTEXT_${context.state.toUpperCase()}`);
    }

    this.clearUserGestureReset();
    return context;
  }

  pauseMediaBridge() {
    if (this.mediaElement && !this.mediaElement.paused) {
      this.mediaElement.pause();
    }
  }

  async decodeClip(key, arrayBuffer) {
    const clipKey = String(key);
    const raw = arrayBuffer.slice(0);
    this.clipData.set(clipKey, raw.slice(0));

    const context = await this.ensureContext({ resume: false });
    const buffer = await context.decodeAudioData(raw);
    this.buffers.set(clipKey, buffer);
    return buffer;
  }

  async loadPack(pack) {
    this.buffers.clear();
    this.clipData.clear();
    const entries = pack?.clips ?? {};
    for (const [key, value] of Object.entries(entries)) {
      const bytes = base64ToArrayBuffer(value);
      await this.decodeClip(key, bytes);
    }
  }

  has(key) {
    return this.buffers.has(String(key));
  }

  duration(key) {
    return this.buffers.get(String(key))?.duration ?? 0;
  }

  async play(key, when = 0) {
    const source = await this.schedule(key, when);
    return Boolean(source);
  }

  async schedule(key, when = 0) {
    const context = await this.ensureContext({ resume: true });
    const buffer = this.buffers.get(String(key));
    if (!buffer) return null;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.masterGain ?? this.outputNode ?? context.destination);
    source.start(Math.max(context.currentTime + 0.01, when));
    return source;
  }

  get currentTime() {
    return this.context?.currentTime ?? 0;
  }
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
