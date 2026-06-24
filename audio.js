export class AudioStore {
  constructor(mediaElement = null) {
    this.context = null;
    this.buffers = new Map();
    this.clipData = new Map();
    this.mediaElement = mediaElement;
    this.mediaDestination = null;
    this.outputNode = null;
    this.masterGain = null;
    this.volume = 1;
    this.usingMediaBridge = false;
    this.contextListeners = new Set();
    this.mediaListeners = new Set();
    this.mediaBridgePaused = false;

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
      this.emitMediaEvent("pause");
    });

    this.mediaElement.addEventListener("playing", () => {
      this.mediaBridgePaused = false;
      this.emitMediaEvent("playing");
    });

    this.mediaElement.addEventListener("ended", () => {
      this.mediaBridgePaused = true;
      this.emitMediaEvent("ended");
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

  async createContext() {
    if (this.mediaElement && this.mediaElement.srcObject) {
      try { this.mediaElement.pause(); } catch { /* optional */ }
      this.mediaElement.srcObject = null;
    }

    this.context = new AudioContext({ latencyHint: "interactive" });
    this.masterGain = this.context.createGain();
    this.masterGain.gain.value = this.volume;
    this.outputNode = this.context.destination;
    this.masterGain.connect(this.outputNode);
    this.mediaDestination = null;
    this.usingMediaBridge = false;
    this.mediaBridgePaused = true;
    this.context.addEventListener("statechange", () => this.emitContextState());
    this.emitContextState();

    if (this.clipData.size > 0) {
      await this.rehydrateBuffers();
    }

    return this.context;
  }

  async rehydrateBuffers() {
    if (!this.context || this.context.state === "closed") return;
    const decoded = new Map();

    for (const [key, bytes] of this.clipData.entries()) {
      const buffer = await this.context.decodeAudioData(bytes.slice(0));
      decoded.set(key, buffer);
    }

    this.buffers = decoded;
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
    const next = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
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
      await this.createContext();
    }

    if (resume && this.context.state !== "running") {
      await this.context.resume();
    }

    if (preferMediaElement) {
      await this.enableMediaBridge();
    }

    return this.context;
  }

  async resumeForUserGesture({ preferMediaElement = false } = {}) {
    const context = await this.ensureContext({ resume: true, preferMediaElement: false });

    // iOS Safari may expose an externally interrupted context. A second resume
    // in the same user gesture is harmless and helps after an audio-session handoff.
    if (context.state !== "running") {
      await context.resume();
    }

    if (preferMediaElement) {
      const bridgeReady = await this.enableMediaBridge();
      if (!bridgeReady) {
        throw new Error("MEDIA_BRIDGE_NOT_READY");
      }
    }

    if (context.state !== "running") {
      throw new Error(`AUDIO_CONTEXT_${context.state.toUpperCase()}`);
    }

    return context;
  }

  async enableMediaBridge() {
    if (!this.context || !this.mediaElement || typeof this.context.createMediaStreamDestination !== "function") {
      return false;
    }

    if (!this.mediaDestination) {
      this.mediaDestination = this.context.createMediaStreamDestination();
      this.mediaElement.srcObject = this.mediaDestination.stream;
      this.mediaElement.playsInline = true;
      this.mediaElement.preload = "auto";
      this.mediaElement.muted = false;
      this.mediaElement.defaultMuted = false;
      this.mediaElement.volume = 1;
    }

    try {
      await this.mediaElement.play();
      this.setOutputNode(this.mediaDestination);
      this.usingMediaBridge = true;
      this.mediaBridgePaused = false;
      return true;
    } catch {
      this.setOutputNode(this.context.destination);
      this.usingMediaBridge = false;
      return false;
    }
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
