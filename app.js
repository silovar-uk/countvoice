import { AudioStore, arrayBufferToBase64 } from "./audio.js";
import { DEFAULT_FINISH_MESSAGE, cueTextForSecond, cueTextsForPack, normalizeFinishMessage } from "./count-format.js";
import { deleteValue, getValue, setValue } from "./db.js";

const BACKGROUND_LOOKAHEAD_SECONDS = 30 * 60;
const FOREGROUND_LOOKAHEAD_SECONDS = 8;
const TICK_INTERVAL_MS = 80;
const FINISH_GAP_SECONDS = 0.1;

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
  targetSecondsLabel: $("targetSecondsLabel"),
  targetSecondsHint: $("targetSecondsHint"),
  intervalSeconds: $("intervalSeconds"),
  audioSource: $("audioSource"),
  finishMessageDisplay: $("finishMessageDisplay"),
  finishMessageStatus: $("finishMessageStatus"),
  testFinishBtn: $("testFinishBtn"),
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
  completed: false,
  startedAt: 0,
  pausedElapsed: 0,
  timerId: null,
  pack: null,
  speakers: [],
  wakeLock: null,
  nextFallbackSecond: 1,
  scheduledUntilSecond: 0,
  scheduledSources: new Set(),
  finishScheduled: false,
  finishPlayed: false,
  finishSource: null,
  finishCleanupTimer: null,
};

init();

async function init() {
  bindEvents();
  configureMediaSession();
  await restorePack();
  render();
  updateFinishMessageUI();
  updateBackgroundStatus();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function bindEvents() {
  els.startBtn.addEventListener("click", start);
  els.pauseBtn.addEventListener("click", pause);
  els.resetBtn.addEventListener("click", reset);
  els.mode.addEventListener("change", () => {
    reset();
    updateTargetCopy();
  });
  els.targetSeconds.addEventListener("change", reset);
  els.intervalSeconds.addEventListener("change", rescheduleRunningAudio);
  els.audioSource.addEventListener("change", rescheduleRunningAudio);
  els.backgroundMode.addEventListener("change", rescheduleRunningAudio);
  els.packInput.addEventListener("change", importPack);
  els.loadPackUrlBtn.addEventListener("click", loadPackFromUrl);
  els.clearPackBtn.addEventListener("click", clearPack);
  els.testVoiceBtn.addEventListener("click", () => playTestCue());
  els.testFinishBtn.addEventListener("click", () => playFinishTest());
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

  if (state.completed) {
    state.pausedElapsed = 0;
    state.nextFallbackSecond = 1;
    state.scheduledUntilSecond = 0;
    state.completed = false;
    clearFinishState();
  }

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
  render();
  tick();
}

function pause() {
  if (!state.running) return;
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
  state.completed = false;
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
  const visible = visibleValue(elapsedFloor, target);
  els.countDisplay.textContent = visible;
  els.countDisplay.setAttribute("aria-label", timerAriaLabel(visible));

  if (usesBufferedPack()) {
    scheduleAudioAhead().catch(() => {});
  } else {
    playFallbackCues(elapsedFloor).catch(() => {});
  }

  if (elapsed >= target) {
    completeCount();
    return;
  }

  state.timerId = setTimeout(tick, TICK_INTERVAL_MS);
}

function completeCount() {
  if (state.completed) return;

  state.running = false;
  state.completed = true;
  state.pausedElapsed = targetSeconds();
  clearTimeout(state.timerId);
  releaseWakeLock();
  render();

  const message = finishMessageText();
  if (usesBufferedPack() && state.finishScheduled) {
    updateBackgroundStatus(`終了しました。${message} を読み上げます。`);
    setMediaSessionState("playing");
    if (state.finishPlayed) finishPlaybackAfterMessage();
    return;
  }

  // 旧パックなど、終了メッセージを含まない場合の保険。
  // 画面表示中はブラウザ音声 / ローカルVOICEVOXで読むことがありますが、
  // iPhoneバックグラウンドで確実に鳴らすには新しいPONVOICEが必要です。
  speakCueNow(message).catch(() => {});
  updateBackgroundStatus(`終了しました。${message} を読み上げました。`);
  deferFinishPlayback(2200);
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
  const lastSecond = Math.min(target, elapsedFloor + horizon);

  if (state.scheduledUntilSecond < elapsedFloor) {
    state.scheduledUntilSecond = elapsedFloor;
  }

  const contextNow = audioStore.currentTime;
  const scheduleFromElapsed = elapsed;

  for (let second = state.scheduledUntilSecond + 1; second <= lastSecond; second += 1) {
    const countValue = countValueAtSecond(second, target);
    if (!shouldSpeak(second, countValue)) continue;

    const text = cueTextForSecond(countValue);
    if (!audioStore.has(text)) continue;

    const when = contextNow + Math.max(0.05, second - scheduleFromElapsed);
    const source = await audioStore.schedule(text, when);
    if (!source) continue;
    rememberScheduledSource(source);
  }

  state.scheduledUntilSecond = lastSecond;

  if (lastSecond >= target) {
    await scheduleFinishMessage(contextNow, scheduleFromElapsed, target);
  }

  updateBackgroundStatus();
}

async function scheduleFinishMessage(contextNow, scheduleFromElapsed, target) {
  if (state.finishScheduled || state.finishPlayed) return;

  const message = finishMessageText();
  if (!audioStore.has(message)) return;

  const finalCountValue = countValueAtSecond(target, target);
  const finalCountText = shouldSpeak(target, finalCountValue) ? cueTextForSecond(finalCountValue) : null;
  const finalCountDuration = finalCountText && audioStore.has(finalCountText)
    ? audioStore.duration(finalCountText)
    : 0;
  const finishWhen = contextNow
    + Math.max(0.05, target - scheduleFromElapsed)
    + finalCountDuration
    + FINISH_GAP_SECONDS;

  const source = await audioStore.schedule(message, finishWhen);
  if (!source) return;

  state.finishScheduled = true;
  state.finishSource = source;
  rememberScheduledSource(source, true);
}

function rememberScheduledSource(source, isFinishMessage = false) {
  state.scheduledSources.add(source);
  source.addEventListener("ended", () => {
    state.scheduledSources.delete(source);
    if (!isFinishMessage) return;

    state.finishPlayed = true;
    state.finishSource = null;
    if (state.completed && !state.running) {
      finishPlaybackAfterMessage();
    }
  }, { once: true });
}

async function playFallbackCues(elapsedFloor) {
  if (elapsedFloor - state.nextFallbackSecond > 3) {
    state.nextFallbackSecond = elapsedFloor;
  }

  const target = targetSeconds();
  while (state.nextFallbackSecond <= Math.min(elapsedFloor, target)) {
    const countValue = countValueAtSecond(state.nextFallbackSecond, target);
    if (shouldSpeak(state.nextFallbackSecond, countValue)) {
      await speakCueNow(cueTextForSecond(countValue));
    }
    state.nextFallbackSecond += 1;
  }
}

function stopScheduledAudio() {
  clearTimeout(state.finishCleanupTimer);
  state.finishCleanupTimer = null;
  state.finishSource = null;
  state.finishScheduled = false;
  state.finishPlayed = false;

  for (const source of state.scheduledSources) {
    try { source.stop(); } catch { /* already ended */ }
  }
  state.scheduledSources.clear();
}

function clearFinishState() {
  clearTimeout(state.finishCleanupTimer);
  state.finishCleanupTimer = null;
  state.finishScheduled = false;
  state.finishPlayed = false;
  state.finishSource = null;
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
    (els.audioSource.value === "pack" || els.audioSource.value === "voicevox")
    && Boolean(state.pack)
    && audioStore.buffers.size > 0
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

async function playFinishTest() {
  const message = finishMessageText();
  if (usesBufferedPack()) {
    await audioStore.ensureContext({ resume: true, preferMediaElement: Boolean(els.backgroundMode.checked) });
    if (audioStore.has(message)) {
      await audioStore.play(message);
      return;
    }
  }
  await speakCueNow(message);
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
  updateFinishMessageUI();
  updateBackgroundStatus();
}

async function clearPack() {
  state.pack = null;
  stopScheduledAudio();
  audioStore.buffers.clear();
  await deleteValue("pack");
  els.packStatus.textContent = "音声パックは未読込です。上の「URLから読み込む」から開始できます。";
  updateFinishMessageUI();
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

function selectedVoicevoxCredit() {
  const label = els.speakerSelect.selectedOptions[0]?.textContent ?? "";
  const speakerName = label.split(" /")[0].trim();
  return speakerName ? `VOICEVOX: ${speakerName}` : "VOICEVOX";
}

async function prepareVoicevoxClips() {
  if (!els.speakerSelect.value && !(await connectVoicevox())) return;
  const clips = {};
  const finish = DEFAULT_FINISH_MESSAGE;
  const cueTexts = cueTextsForPack("standard", finish);
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
    version: 2,
    meta: {
      name: "VOICEVOX count standard",
      createdAt: new Date().toISOString(),
      speakerStyleId: Number(els.speakerSelect.value),
      finishMessage: finish,
      credit: selectedVoicevoxCredit(),
    },
    clips,
  };

  await saveLoadedPack(pack);
  els.audioSource.value = "voicevox";
  els.packStatus.textContent = `VOICEVOXの標準音声と、終了メッセージ「${finish}」を準備しました。開始できます。`;
}

async function synthesizeAndCache(text) {
  const buffer = await synthesizeVoicevox(String(text), Number(els.speakerSelect.value));
  await audioStore.decodeClip(text, buffer);
  const pack = state.pack ?? { kind: "ponvoice", version: 2, meta: { name: "local cache" }, clips: {} };
  pack.clips[String(text)] = arrayBufferToBase64(buffer);
  if (String(text) === finishMessageText()) {
    pack.meta.finishMessage = String(text);
  }
  state.pack = pack;
  await setValue("pack", pack);
  updateFinishMessageUI();
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
  const elapsed = Math.min(Math.floor(elapsedSeconds()), target);
  const visible = visibleValue(elapsed, target);
  els.modeLabel.textContent = els.mode.value === "down" ? "カウントダウン" : "カウントアップ";
  els.unitLabel.textContent = "秒";
  els.countDisplay.textContent = visible;
  els.countDisplay.setAttribute("aria-label", timerAriaLabel(visible));
  els.startBtn.textContent = state.completed ? "もう一度開始" : state.pausedElapsed > 0 ? "再開" : "開始";
  updateTargetCopy();
}

function targetSeconds() {
  return clamp(Number(els.targetSeconds.value) || 60, 1, 86400);
}

function countValueAtSecond(second, target) {
  return els.mode.value === "down" ? Math.max(0, target - second) : Math.min(target, second);
}

function visibleValue(elapsed, target) {
  return els.mode.value === "down" ? Math.max(0, target - elapsed) : Math.min(target, elapsed);
}

function timerAriaLabel(value) {
  return `${els.mode.value === "down" ? "残り" : "経過"}時間 ${value}秒`;
}

function updateTargetCopy() {
  const duration = formatDuration(targetSeconds());
  if (els.mode.value === "up") {
    els.targetSecondsLabel.textContent = "終了まで（秒）";
    els.targetSecondsHint.textContent = `カウントアップも ${duration} で自動終了します。例：300秒 = 5分`;
  } else {
    els.targetSecondsLabel.textContent = "開始時間（秒）";
    els.targetSecondsHint.textContent = `カウントダウンは ${duration} から開始し、0秒で終了します。`;
  }
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remain = seconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours}時間`);
  if (minutes) parts.push(`${minutes}分`);
  if (remain || parts.length === 0) parts.push(`${remain}秒`);
  return parts.join("");
}

function finishMessageText() {
  return normalizeFinishMessage(state.pack?.meta?.finishMessage ?? DEFAULT_FINISH_MESSAGE);
}

function updateFinishMessageUI() {
  const message = finishMessageText();
  els.finishMessageDisplay.textContent = `「${message}」`;

  if (!state.pack) {
    els.finishMessageStatus.textContent = "標準の終了メッセージです。音声パックを読み込むと、バックグラウンド再生用の音声を確認できます。";
    return;
  }

  if (audioStore.has(message)) {
    els.finishMessageStatus.textContent = "この音声パックには、終了メッセージの音声が入っています。終了時に予約再生します。";
    return;
  }

  els.finishMessageStatus.textContent = "この音声パックには終了メッセージが入っていません。VOICEVOXで新しいPONVOICEを作ると、iPhoneのバックグラウンドでも予約再生できます。";
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

function deferFinishPlayback(delayMs) {
  clearTimeout(state.finishCleanupTimer);
  state.finishCleanupTimer = setTimeout(() => finishPlaybackAfterMessage(), delayMs);
}

function finishPlaybackAfterMessage() {
  if (state.running || !state.completed) return;
  clearTimeout(state.finishCleanupTimer);
  state.finishCleanupTimer = null;
  audioStore.pauseMediaBridge();
  setMediaSessionState("none");
  updateBackgroundStatus(`終了しました。${finishMessageText()} を読み上げました。`);
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

  if (!hasFinishAudio()) {
    els.backgroundStatus.textContent = "このパックには終了メッセージがありません。VOICEVOXで新しいPONVOICEを作ると、終了時も予約再生できます。";
    return;
  }

  if (!els.backgroundMode.checked) {
    els.backgroundStatus.textContent = "通常モードです。画面表示中の再生を優先します。";
    return;
  }

  const sessionReady = "audioSession" in navigator;
  const bridgeReady = audioStore.usingMediaBridge;
  if (state.running) {
    els.backgroundStatus.textContent = `${sessionReady ? "再生セッションを設定し、" : "再生セッション非対応のため、"}${BACKGROUND_LOOKAHEAD_SECONDS / 60}分先まで音声と終了メッセージを予約中です${bridgeReady ? "。" : "（端末側のメディア再生を利用できない場合があります）。"}`;
    return;
  }

  els.backgroundStatus.textContent = `開始時に${BACKGROUND_LOOKAHEAD_SECONDS / 60}分先まで音声を予約します。終了時は「${finishMessageText()}」を読み上げます。`;
}

function hasFinishAudio() {
  return Boolean(state.pack) && audioStore.has(finishMessageText());
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
