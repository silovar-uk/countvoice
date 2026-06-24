export class AudioStore {
  constructor(mediaElement = null) {
    this.context = null;
    this.buffers = new Map();
    this.mediaElement = mediaElement;
    this.mediaDestination = null;
    this.outputNode = null;
    this.usingMediaBridge = false;
  }

  async ensureContext({ resume = true, preferMediaElement = false } = {}) {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: "interactive" });
      this.outputNode = this.context.destination;
    }

    if (resume && this.context.state === "suspended") {
      await this.context.resume();
    }

    if (preferMediaElement) {
      await this.enableMediaBridge();
    }

    return this.context;
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
      this.mediaElement.volume = 1;
    }

    try {
      await this.mediaElement.play();
      this.outputNode = this.mediaDestination;
      this.usingMediaBridge = true;
      return true;
    } catch {
      this.outputNode = this.context.destination;
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
    const context = await this.ensureContext({ resume: false });
    const copy = arrayBuffer.slice(0);
    const buffer = await context.decodeAudioData(copy);
    this.buffers.set(String(key), buffer);
    return buffer;
  }

  async loadPack(pack) {
    this.buffers.clear();
    const entries = pack?.clips ?? {};
    for (const [key, value] of Object.entries(entries)) {
      const bytes = base64ToArrayBuffer(value);
      await this.decodeClip(key, bytes);
    }
  }

  has(key) {
    return this.buffers.has(String(key));
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
    source.connect(this.outputNode ?? context.destination);
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
