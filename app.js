import { AudioStore, arrayBufferToBase64 } from "./audio.js";
import { cueTextForSecond, cueTextsForPack } from "./count-format.js";
import { deleteValue, getValue, setValue } from "./db.js";

const BACKGROUND_LOOKAHEAD_SECONDS = 30 * 60;
const FOREGROUND_LOOKAHEAD_SECONDS = 8;
const TICK_INTERVAL_MS = 80;

const $ = (id) => document.getElementById(id);

const els = {
  countDisplay: $("countDisplay"),
  modeLabel: $("modeLabel"),
  unitLabel: $("unitLabel"),
  startBtn: $("startBtn"),
  pauseBtn: $("pauseBtn"),
  resetBtn: $("resetBtn"),
  mode: $("mode"),
  targetSeconds: $("targetSeconds"),
  intervalSeconds: $("intervalSeconds"),
  audioSource: $("audioSource"),
  backgroundMode: $("backgroundMode"),
  backgroundStatus: $("backgroundStatus"),
  backgroundAudio: $("backgroundAudio"),
  packInput: $("packInput"),
  packUrl: $("packUrl"),
  loadPackUrlBtn: $("loadPackUrlBtn"),
  clearPackBtn: $("clearPackBtn"),
  testVoiceBtn: $("testVoiceBtn"),
  packStatus: $("packStatus"),
  engineUrl: $("engineUrl"),
  connectBtn: $("connectBtn"),
  speakerSelect: $("speakerSelect"),
  prepareBtn: $("prepareBtn"),
  prepareProgress: $("prepareProgress"),
  voicevoxStatus: $("voicevoxStatus"),
};

const audioStore = new AudioStore(els.backgroundAudio);
const state = {
  running: false,
  startedAt: 0,
  pausedElapsed: 0,
  timerId: null,
  pack: null,
  speakers: [],
  wakeLock: null,
  nextFallbackSecond: 1,
  scheduledUntilSecond: 0,
  scheduledSources: new Set(),
};

init();

async function init() {
  bindEvents();
  configureMediaSession();
  await restorePack();
  render();
  updateBackgroundStatus();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function bindEvents() {
  els.startBtn.addEventListener("click", start);
  els.pauseBtn.addEventListener("click", pause);
  els.resetBtn.addEventListener("click", reset);
  els.mode.addEventListener("change", reset);
  els.targetSeconds.addEventListener("change", reset);
  els.intervalSeconds.addEventListener("change", rescheduleRunningAudio);
  els.audioSource.addEventListener("change", rescheduleRunningAudio);
  els.backgroundMode.addEventListener("change", rescheduleRunningAudio);
  els.packInput.addEventListener("change", importPack);
  els.loadPackUrlBtn.addEventListener("click", loadPackFromUrl);
  els.clearPackBtn.addEventListener("click", clearPack);
  els.testVoiceBtn.addEventListener("click", () => playTestCue());
  els.connectBtn.addEventListener("click", connectVoicevox);
  els.prepareBtn.addEventListener("click", prepareVoicevoxClips);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pagehide", () => {
    if (!state.running) stopScheduledAudio();
  });
}

async function restorePack() {
  const initialPackUrl = new URLSearchParams(location.search).get("pack");
  if (initialPackUrl) {
    els.packUrl.value = initialPackUrl;
    await loadPackFromUrl();
    return;
  }

  const pack = await getValue("pack");
  if (!pack) return;
  state.pack = pack;
  await audioStore.loadPack(pack);
  els.packStatus.textContent = `${pack.meta?.name ?? "音声パック"} を読込済みです。開始できます。`;
}

async function start() {
  if (state.running) return;

  if (usesBufferedPack()) {
    try {
      await audioStore.ensureContext({
        resume: true,
        preferMediaElement: Boolean(els.backgroundMode.checked),
      });
    } catch {
      els.backgroundStatus.textContent = "音声の開始を許可できませんでした。もう一度「開始」を押してください。";
      return;
    }
  }

  configurePlaybackAudioSession();
  state.running = true;
  state.startedAt = performance.now() - state.pausedElapsed * 1000;
  state.nextFallbackSecond = Math.floor(state.pausedElapsed) + 1;
  state.scheduledUntilSecond = Math.floor(state.pausedElapsed);
  setMediaSessionState("playing");
  await requestWakeLock();
  await scheduleAudioAhead();
  tick();
}

function pause() {
  state.pausedElapsed = elapsedSeconds();
  state.running = false;
  clearTimeout(state.timerId);
  stopScheduledAudio();
  audioStore.pauseMediaBridge();
  releaseWakeLock();
  setMediaSessionState("paused");
  render();
  updateBackgroundStatus("一時停止中です。");
}

function reset() {
  state.running = false;
  clearTimeout(state.timerId);
  state.pausedElapsed = 0;
  state.nextFallbackSecond = 1;
  state.scheduledUntilSecond = 0;
  stopScheduledAudio();
  audioStore.pauseMediaBridge();
  releaseWakeLock();
  setMediaSessionState("none");
  render();
  updateBackgroundStatus();
}

function tick() {
  if (!state.running) return;

  const elapsed = elapsedSeconds();
  const target = targetSeconds();
  const elapsedFloor = Math.floor(elapsed);
  const visible = els.mode.value === "down" ? Math.max(0, target - elapsedFloor) : elapsedFloor;
  els.countDisplay.textContent = visible;
  els.countDisplay.setAttribute("aria-label", `${els.mode.value === "down" ? "残り" : "経過"}時間 ${visible}秒`);

  if (usesBufferedPack()) {
    scheduleAudioAhead().catch(() => {});
  } else {
    playFallbackCues(elapsedFloor).catch(() => {});
  }

  if (els.mode.value === "down" && elapsed >= target) {
    state.running = false;
    state.pausedElapsed = target;
    stopScheduledAudio();
    setMediaSessionState("none");
    render();
    updateBackgroundStatus("カウントダウンが完了しました。");
    return;
  }

  state.timerId = setTimeout(tick, TICK_INTERVAL_MS);
}

function elapsedSeconds() {
  if (!state.running) return state.pausedElapsed;
  return Math.max(0, (performance.now() - state.startedAt) / 1000);
}

async function scheduleAudioAhead() {
  if (!state.running || !usesBufferedPack()) return;

  const elapsed = elapsedSeconds();
  const elapsedFloor = Math.floor(elapsed);
  const target = targetSeconds();
  const horizon = els.backgroundMode.checked ? BACKGROUND_LOOKAHEAD_SECONDS : FOREGROUND_LOOKAHEAD_SECONDS;
  const lastSecond = els.mode.value === "down"
    ? Math.min(target, elapsedFloor + horizon)
    : elapsedFloor + horizon;

  if (state.scheduledUntilSecond < elapsedFloor) {
    state.scheduledUntilSecond = elapsedFloor;
  }

  const contextNow = audioStore.currentTime;
  const scheduleFromElapsed = elapsed;

  for (let second = state.scheduledUntilSecond + 1; second <= lastSecond; second += 1) {
    const countValue = els.mode.value === "down" ? Math.max(0, target - second) : second;
    if (!shouldSpeak(second, countValue)) continue;

    const text = cueTextForSecond(countValue);
    if (!audioStore.has(text)) continue;

    const when = contextNow + Math.max(0.05, second - scheduleFromElapsed);
    const source = await audioStore.schedule(text, when);
    if (!source) continue;

    state.scheduledSources.add(source);
    source.addEventListener("ended", () => state.scheduledSources.delete(source), { once: true });
  }

  state.scheduledUntilSecond = lastSecond;
  updateBackgroundStatus();
}

async function playFallbackCues(elapsedFloor) {
  if (elapsedFloor - state.nextFallbackSecond > 3) {
    state.nextFallbackSecond = elapsedFloor;
  }

  while (state.nextFallbackSecond <= elapsedFloor) {
    const target = targetSeconds();
    const countValue = els.mode.value === "down"
      ? Math.max(0, target - state.nextFallbackSecond)
      : state.nextFallbackSecond;
    if (shouldSpeak(state.nextFallbackSecond, countValue)) {
      await speakCueNow(cueTextForSecond(countValue));
    }
    state.nextFallbackSecond += 1;
  }
}

function stopScheduledAudio() {
  for (const source of state.scheduledSources) {
    try { source.stop(); } catch { /* already ended */ }
  }
  state.scheduledSources.clear();
}

async function handleVisibilityChange() {
  if (!state.running) return;

  if (document.visibilityState === "visible") {
    await requestWakeLock();
    await scheduleAudioAhead();
    tick();
  }
}

async function rescheduleRunningAudio() {
  updateBackgroundStatus();
  if (!state.running) return;
  stopScheduledAudio();
  state.scheduledUntilSecond = Math.floor(elapsedSeconds());
  state.nextFallbackSecond = state.scheduledUntilSecond + 1;
  await scheduleAudioAhead();
}

function usesBufferedPack() {
  return (
    (els.audioSource.value === "pack" || els.audioSource.value === "voicevox") &&
    Boolean(state.pack) &&
    audioStore.buffers.size > 0
  );
}

function shouldSpeak(second, countValue) {
  const interval = Number(els.intervalSeconds.value) || 1;
  return second % interval === 0 || countValue === 0;
}

async function playTestCue() {
  if (usesBufferedPack()) {
    await audioStore.ensureContext({ resume: true, preferMediaElement: Boolean(els.backgroundMode.checked) });
    await audioStore.play("1");
    return;
  }
  await speakCueNow("1");
}

async function speakCueNow(text) {
  if (els.audioSource.value === "silent") return;
  const key = String(text);

  if ((els.audioSource.value === "pack" || els.audioSource.value === "voicevox") && audioStore.has(key)) {
    await audioStore.play(key);
    return;
  }

  if (els.audioSource.value === "voicevox") {
    const generated = await synthesizeAndCache(text).catch(() => null);
    if (generated) {
      await audioStore.play(key);
      return;
    }
  }

  if (els.audioSource.value === "browser" || els.audioSource.value === "pack") {
    browserSpeak(text);
  }
}

function browserSpeak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(String(text));
  utterance.lang = "ja-JP";
  utterance.rate = 1.2;
  speechSynthesis.speak(utterance);
}

async function importPack(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const pack = JSON.parse(await file.text());
    await saveLoadedPack(pack);
    els.packStatus.textContent = `${pack.meta?.name ?? file.name} を取り込みました。開始できます。`;
  } catch {
    els.packStatus.textContent = "PONVOICEとして読み込めませんでした。ファイルの中身を確認してください。";
  } finally {
    event.target.value = "";
  }
}

async function loadPackFromUrl() {
  const rawUrl = els.packUrl.value.trim();
  if (!rawUrl) {
    els.packStatus.textContent = "音声パックURLを入力してください。";
    return;
  }

  try {
    els.loadPackUrlBtn.disabled = true;
    els.packStatus.textContent = "URLから音声パックを読み込んでいます...";
    const response = await fetch(rawUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const pack = JSON.parse(await response.text());
    await saveLoadedPack(pack);
    els.packStatus.textContent = `${pack.meta?.name ?? "音声パック"} をURLから読み込みました。開始できます。`;
  } catch {
    els.packStatus.textContent = "URLからPONVOICEを読み込めませんでした。同じサイト内のURLか、CORS許可されたURLを指定してください。";
  } finally {
    els.loadPackUrlBtn.disabled = false;
  }
}

async function saveLoadedPack(pack) {
  validatePack(pack);
  state.pack = pack;
  await setValue("pack", pack);
  await audioStore.loadPack(pack);
  els.audioSource.value = "pack";
  updateBackgroundStatus();
}

async function clearPack() {
  state.pack = null;
  stopScheduledAudio();
  audioStore.buffers.clear();
  await deleteValue("pack");
  els.packStatus.textContent = "音声パックは未読込です。上の「URLから読み込む」から開始できます。";
  updateBackgroundStatus();
}

function validatePack(pack) {
  if (!pack || pack.kind !== "ponvoice" || !pack.clips) {
    throw new Error("ponvoice形式ではありません。");
  }
}

async function connectVoicevox() {
  const baseUrl = cleanEngineUrl();
  els.voicevoxStatus.textContent = "接続中...";
  try {
    const speakers = await fetchJson(`${baseUrl}/speakers`);
    state.speakers = speakers;
    fillSpeakerSelect(speakers);
    els.voicevoxStatus.textContent = "接続しました。話者を選べます。";
    return true;
  } catch {
    els.voicevoxStatus.textContent = "接続できませんでした。PCでVOICEVOX Engineを起動してください。";
    return false;
  }
}

function fillSpeakerSelect(speakers) {
  els.speakerSelect.innerHTML = "";
  for (const speaker of speakers) {
    for (const style of speaker.styles) {
      const option = document.createElement("option");
      option.value = style.id;
      option.textContent = `${speaker.name} / ${style.name}`;
      if (speaker.name.includes("ずんだもん") && style.name.includes("ノーマル")) option.selected = true;
      els.speakerSelect.append(option);
    }
  }
}

async function prepareVoicevoxClips() {
  if (!els.speakerSelect.value && !(await connectVoicevox())) return;
  const clips = {};
  const cueTexts = cueTextsForPack("standard");
  els.prepareProgress.max = cueTexts.length;
  els.prepareProgress.value = 0;

  for (const [index, text] of cueTexts.entries()) {
    const buffer = await synthesizeVoicevox(text, Number(els.speakerSelect.value));
    clips[text] = arrayBufferToBase64(buffer);
    await audioStore.decodeClip(text, buffer);
    els.prepareProgress.value = index + 1;
  }

  const pack = {
    kind: "ponvoice",
    version: 1,
    meta: {
      name: "VOICEVOX count standard",
      createdAt: new Date().toISOString(),
      speakerStyleId: Number(els.speakerSelect.value),
      credit: "VOICEVOX",
    },
    clips,
  };

  await saveLoadedPack(pack);
  els.audioSource.value = "voicevox";
  els.packStatus.textContent = "VOICEVOXの標準音声を準備しました。開始できます。";
}

async function synthesizeAndCache(text) {
  const buffer = await synthesizeVoicevox(String(text), Number(els.speakerSelect.value));
  await audioStore.decodeClip(text, buffer);
  const pack = state.pack ?? { kind: "ponvoice", version: 1, meta: { name: "local cache" }, clips: {} };
  pack.clips[String(text)] = arrayBufferToBase64(buffer);
  state.pack = pack;
  await setValue("pack", pack);
  return true;
}

async function synthesizeVoicevox(text, speakerId) {
  const baseUrl = cleanEngineUrl();
  const query = await fetchJson(`${baseUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`, { method: "POST" });
  const response = await fetch(`${baseUrl}/synthesis?speaker=${speakerId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query),
  });
  if (!response.ok) throw new Error("VOICEVOX synthesis failed");
  return response.arrayBuffer();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function cleanEngineUrl() {
  return els.engineUrl.value.replace(/\/$/, "");
}

function render() {
  const target = targetSeconds();
  const elapsed = Math.floor(elapsedSeconds());
  const visible = els.mode.value === "down" ? Math.max(0, target - elapsed) : elapsed;
  els.modeLabel.textContent = els.mode.value === "down" ? "カウントダウン" : "カウントアップ";
  els.unitLabel.textContent = "秒";
  els.countDisplay.textContent = visible;
  els.countDisplay.setAttribute("aria-label", `${els.mode.value === "down" ? "残り" : "経過"}時間 ${visible}秒`);
}

function targetSeconds() {
  return clamp(Number(els.targetSeconds.value) || 60, 1, 86400);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
  } catch {
    state.wakeLock = null;
  }
}

function releaseWakeLock() {
  if (!state.wakeLock) return;
  state.wakeLock.release().catch(() => {});
  state.wakeLock = null;
}

function configurePlaybackAudioSession() {
  if (!("audioSession" in navigator)) return false;
  try {
    navigator.audioSession.type = "playback";
    return true;
  } catch {
    return false;
  }
}

function configureMediaSession() {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "毎秒カウント",
      artist: "CountVoice",
      album: "音声カウント",
    });
    navigator.mediaSession.setActionHandler("play", () => start());
    navigator.mediaSession.setActionHandler("pause", () => pause());
    navigator.mediaSession.setActionHandler("stop", () => pause());
  } catch {
    // Media Session API is optional.
  }
}

function setMediaSessionState(value) {
  if (!("mediaSession" in navigator)) return;
  try { navigator.mediaSession.playbackState = value; } catch { /* optional */ }
}

function updateBackgroundStatus(message = "") {
  if (message) {
    els.backgroundStatus.textContent = message;
    return;
  }

  if (!state.pack || audioStore.buffers.size === 0) {
    els.backgroundStatus.textContent = "まず上の「URLから読み込む」で音声パックを準備してください。";
    return;
  }

  if (!els.backgroundMode.checked) {
    els.backgroundStatus.textContent = "通常モードです。画面表示中の再生を優先します。";
    return;
  }

  const sessionReady = "audioSession" in navigator;
  const bridgeReady = audioStore.usingMediaBridge;
  if (state.running) {
    els.backgroundStatus.textContent = `${sessionReady ? "再生セッションを設定し、" : "再生セッション非対応のため、"}${BACKGROUND_LOOKAHEAD_SECONDS / 60}分先まで音声を予約中です${bridgeReady ? "。" : "（端末側のメディア再生を利用できない場合があります）。"}`;
    return;
  }

  els.backgroundStatus.textContent = `開始時に${BACKGROUND_LOOKAHEAD_SECONDS / 60}分先まで音声を予約します。iPhoneではホーム画面追加版で試してください。`;
}
