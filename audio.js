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

    // Ambient-noise settings are kept separately from the spoken-voice volume.
    // The app owns when the noise should be playing; this store owns the audio nodes.
    this.ambientMode = "none";
    this.ambientLevel = 0.18;
    this.ambientSource = null;
    this.ambientGain = null;
    this.ambientContext = null;
    this.ambientActiveMode = "none";
    this.ambientPreviewTimer = null;

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
    this.ambientSource = null;
    this.ambientGain = null;
    this.ambientContext = null;
    this.ambientActiveMode = "none";
    this.clearAmbientPreviewTimer();
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
    this.stopAmbientNoise({ fadeOut: 0 });
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

  setAmbientNoise({ mode = this.ambientMode, level = this.ambientLevel } = {}) {
    const nextMode = ["none", "white", "brown"].includes(mode) ? mode : "none";
    const parsed = Number(level);
    const nextLevel = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : this.ambientLevel;
    const modeChanged = nextMode !== this.ambientMode;

    this.ambientMode = nextMode;
    this.ambientLevel = nextLevel;

    if (this.ambientGain && this.context && this.context.state !== "closed") {
      const now = this.context.currentTime;
      try {
        this.ambientGain.gain.cancelScheduledValues(now);
        this.ambientGain.gain.setTargetAtTime(nextLevel, now, 0.028);
      } catch {
        this.ambientGain.gain.value = nextLevel;
      }
    }

    if (nextMode === "none" || (modeChanged && this.ambientSource)) {
      this.stopAmbientNoise();
    }

    return { mode: this.ambientMode, level: this.ambientLevel };
  }

  clearAmbientPreviewTimer() {
    if (!this.ambientPreviewTimer) return;
    clearTimeout(this.ambientPreviewTimer);
    this.ambientPreviewTimer = null;
  }

  async previewAmbientNoise({ mode = this.ambientMode, level = this.ambientLevel, durationMs = 3000 } = {}) {
    this.setAmbientNoise({ mode, level });
    if (this.ambientMode === "none") return false;

    // This is invoked directly from an explicit tap. It deliberately opens/resumes
    // the AudioContext here so iPhone Safari treats the preview as user initiated.
    await this.resumeForUserGesture({ preferMediaElement: false, forceRecreate: false });
    const started = await this.startAmbientNoise({
      mode: this.ambientMode,
      level: this.ambientLevel,
      restart: true,
    });
    if (!started) return false;

    this.clearAmbientPreviewTimer();
    const wait = Math.max(500, Number(durationMs) || 3000);
    this.ambientPreviewTimer = setTimeout(() => {
      this.ambientPreviewTimer = null;
      this.stopAmbientNoise({ fadeOut: 0.1 });
    }, wait);
    return true;
  }

  createAmbientBuffer(mode, context) {
    const seconds = mode === "brown" ? 18 : 12;
    const length = Math.max(1, Math.floor(context.sampleRate * seconds));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const output = buffer.getChannelData(0);

    if (mode === "brown") {
      let brown = 0;
      for (let index = 0; index < length; index += 1) {
        const white = Math.random() * 2 - 1;
        brown = (brown + white * 0.035) * 0.9975;
        output[index] = brown;
      }

      // Remove the start/end drift so a loop point does not create a large click.
      const start = output[0];
      const end = output[length - 1];
      const denominator = Math.max(1, length - 1);
      let peak = 0;
      for (let index = 0; index < length; index += 1) {
        const value = output[index] - (start + (end - start) * (index / denominator));
        output[index] = value;
        peak = Math.max(peak, Math.abs(value));
      }
      const scale = peak > 0 ? 0.94 / peak : 1;
      for (let index = 0; index < length; index += 1) output[index] *= scale;
      return buffer;
    }

    for (let index = 0; index < length; index += 1) {
      output[index] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  async startAmbientNoise({ mode = this.ambientMode, level = this.ambientLevel, restart = false } = {}) {
    this.clearAmbientPreviewTimer();
    this.setAmbientNoise({ mode, level });
    if (this.ambientMode === "none") return false;

    const context = await this.ensureContext({ resume: true });
    if (context.state !== "running" || !this.masterGain) return false;

    const canReuse = this.ambientSource
      && this.ambientContext === context
      && this.ambientActiveMode === this.ambientMode;

    if (canReuse && !restart) {
      this.setAmbientNoise({ mode: this.ambientMode, level: this.ambientLevel });
      return true;
    }

    this.stopAmbientNoise({ fadeOut: restart ? 0.025 : 0 });

    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = this.createAmbientBuffer(this.ambientMode, context);
    source.loop = true;
    gain.gain.setValueAtTime(0, context.currentTime);
    source.connect(gain).connect(this.masterGain);

    const startAt = context.currentTime + 0.012;
    const fadeTarget = this.ambientLevel;
    try {
      gain.gain.linearRampToValueAtTime(fadeTarget, startAt + 0.09);
    } catch {
      gain.gain.value = fadeTarget;
    }

    this.ambientSource = source;
    this.ambientGain = gain;
    this.ambientContext = context;
    this.ambientActiveMode = this.ambientMode;

    source.addEventListener("ended", () => {
      if (this.ambientSource === source) {
        this.ambientSource = null;
        this.ambientGain = null;
        this.ambientContext = null;
        this.ambientActiveMode = "none";
      }
      try { source.disconnect(); } catch { /* optional cleanup */ }
      try { gain.disconnect(); } catch { /* optional cleanup */ }
    }, { once: true });

    try {
      source.start(startAt);
      return true;
    } catch {
      if (this.ambientSource === source) {
        this.ambientSource = null;
        this.ambientGain = null;
        this.ambientContext = null;
        this.ambientActiveMode = "none";
      }
      return false;
    }
  }

  stopAmbientNoise({ fadeOut = 0.07 } = {}) {
    const source = this.ambientSource;
    const gain = this.ambientGain;
    const context = this.ambientContext ?? this.context;

    this.ambientSource = null;
    this.ambientGain = null;
    this.ambientContext = null;
    this.ambientActiveMode = "none";

    if (!source) return;
    const fade = Math.max(0, Number(fadeOut) || 0);
    const now = context?.currentTime ?? 0;

    try {
      if (gain && context && context.state !== "closed") {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        if (fade > 0) gain.gain.linearRampToValueAtTime(0.0001, now + fade);
      }
    } catch { /* optional fade */ }

    try { source.stop(now + fade + 0.035); } catch { /* already ended */ }
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
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
