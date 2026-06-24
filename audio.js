export class AudioStore {
  constructor() {
    this.context = null;
    this.buffers = new Map();
  }

  async ensureContext() {
    if (!this.context) {
      this.context = new AudioContext();
    }
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
    return this.context;
  }

  async decodeClip(key, arrayBuffer) {
    const context = await this.ensureContext();
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
    const context = await this.ensureContext();
    const buffer = this.buffers.get(String(key));
    if (!buffer) return false;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(Math.max(context.currentTime, when));
    return true;
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
