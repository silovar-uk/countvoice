import { AudioStore, arrayBufferToBase64 } from "./audio.js";
import { DEFAULT_FINISH_MESSAGE, cueTextForSecond, cueTextsForPack, normalizeFinishMessage } from "./count-format.js";
import { deleteValue, getValue, setValue } from "./db.js";

const BACKGROUND_LOOKAHEAD_SECONDS = 30 * 60;
const FOREGROUND_LOOKAHEAD_SECONDS = 8;
const TICK_INTERVAL_MS = 80;
const FINISH_GAP_SECONDS = 0.18;
const FINISH_REPEAT_GAP_SECONDS = 0.42;
const FINISH_PLAY_COUNT = 2;
const DEFAULT_APP_VOLUME_PERCENT = 50;
const DEFAULT_AMBIENT_NOISE_MODE = "none";
const DEFAULT_AMBIENT_NOISE_VOLUME_PERCENT = 18;

const $ = (id) => document.getElementById(id);

const els = {
  countDisplay: $("countDisplay"),
  modeLabel: $("modeLabel"),
  unitLabel: $("unitLabel"),
  countState: $("countState"),
  targetSummary: $("targetSummary"),
  sessionProgress: $("sessionProgress"),
  cheerMessage: $("cheerMessage"),
  startBtn: $("startBtn"),
  pauseBtn: $("pauseBtn"),
  resetBtn: $("resetBtn"),
  audioRecovery: $("audioRecovery"),
  audioRecoveryMessage: $("audioRecoveryMessage"),
  resumeAudioBtn: $("resumeAudioBtn"),
  volumeSlider: $("volumeSlider"),
  volumeValue: $("volumeValue"),
  ambientControl: $("ambientControl"),
  noiseMode: $("noiseMode"),
  noiseVolumeSlider: $("noiseVolumeSlider"),
  noiseVolumeDownBtn: $("noiseVolumeDownBtn"),
  noiseVolumeUpBtn: $("noiseVolumeUpBtn"),
  noiseVolumeValue: $("noiseVolumeValue"),
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
  quickLoadCard: $("quickLoadCard"),
  quickLoadEditor: $("quickLoadEditor"),
  packReadyName: $("packReadyName"),
  reloadPackBtn: $("reloadPackBtn"),
  togglePackEditorBtn: $("togglePackEditorBtn"),
  clearPackBtn: $("clearPackBtn"),
  testVoiceBtn: $("testVoiceBtn"),
  packStatus: $("packStatus"),
  soundSettings: $("soundSettings"),
  soundSettingsSummary: $("soundSettingsSummary"),
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
  cancelledSources: new WeakSet(),
  finishSources: new Set(),
  finishScheduled: false,
  finishPlayed: false,
  finishPlayedCount: 0,
  finishSource: null,
  finishCleanupTimer: null,
  finishGeneration: 0,
  finishSequencePromise: null,
  audioNeedsRecovery: false,
  audioRecoveryInFlight: false,
  audioReschedulePromise: null,
  volume: DEFAULT_APP_VOLUME_PERCENT / 100,
  volumeSaveTimer: null,
  ambientNoiseMode: DEFAULT_AMBIENT_NOISE_MODE,
  ambientNoiseVolume: DEFAULT_AMBIENT_NOISE_VOLUME_PERCENT / 100,
  ambientNoiseSaveTimer: null,
  ambientSettingsTouched: false,
  ambientNoiseVolumeTouched: false,
};

init();

async function init() {
  bindEvents();
  bindAudioRecoverySignals();
  configureMediaSession();
  syncPackLoadUI({ editorOpen: true });
  updateSoundSettingsSummary();
  await restoreVolume();
  await restoreAmbientNoise();
  await restorePack();
  updateSoundSettingsSummary();
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
  els.resumeAudioBtn.addEventListener("click", recoverAudioFromUserAction);
  els.volumeSlider.addEventListener("input", () => setAppVolume(els.volumeSlider.value));
  els.volumeSlider.addEventListener("change", () => flushVolumeSave());
  els.noiseMode.addEventListener("input", handleAmbientNoiseModeControl);
  els.noiseMode.addEventListener("change", handleAmbientNoiseModeControl);
  els.noiseVolumeSlider.addEventListener("input", handleAmbientNoiseVolumeControl);
  els.noiseVolumeSlider.addEventListener("change", () => {
    handleAmbientNoiseVolumeControl();
    flushAmbientNoiseSave();
  });
  // iOS Safari occasionally misses the first range `input` after a select change.
  // Read the final thumb value on touch/pointer release as a fallback.
  els.noiseVolumeSlider.addEventListener("touchend", handleAmbientNoiseVolumeControl, { passive: true });
  els.noiseVolumeSlider.addEventListener("pointerup", handleAmbientNoiseVolumeControl);
  els.noiseVolumeDownBtn?.addEventListener("click", () => nudgeAmbientNoiseVolume(-5));
  els.noiseVolumeUpBtn?.addEventListener("click", () => nudgeAmbientNoiseVolume(5));
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
  els.reloadPackBtn.addEventListener("click", loadPackFromUrl);
  els.togglePackEditorBtn.addEventListener("click", togglePackEditor);
  els.soundSettings.addEventListener("toggle", () => {
    document.body.dataset.soundSettingsOpen = String(els.soundSettings.open);
  });
  els.clearPackBtn.addEventListener("click", clearPack);
  els.testVoiceBtn.addEventListener("click", () => playTestCue());
  els.testFinishBtn.addEventListener("click", () => playFinishTest());
  els.connectBtn.addEventListener("click", connectVoicevox);
  els.prepareBtn.addEventListener("click", prepareVoicevoxClips);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("focus", handleReturnToApp);
  window.addEventListener("pageshow", handleReturnToApp);
  window.addEventListener("pagehide", handlePageHide);
}

async function restoreVolume() {
  const stored = await getValue("appVolume").catch(() => null);
  const parsed = Number(stored);
  const percent = Number.isFinite(parsed) ? parsed : DEFAULT_APP_VOLUME_PERCENT;
  setAppVolume(percent, { save: false });
}

function setAppVolume(percent, { save = true } = {}) {
  const normalizedPercent = clamp(Math.round(Number(percent) || 0), 0, 100);
  state.volume = normalizedPercent / 100;
  els.volumeSlider.value = String(normalizedPercent);
  els.volumeSlider.setAttribute("aria-valuenow", String(normalizedPercent));
  els.volumeSlider.setAttribute("aria-valuetext", `${normalizedPercent}%`);
  els.volumeValue.textContent = `${normalizedPercent}%`;
  audioStore.setVolume(state.volume);
  updateSoundSettingsSummary();

  if (save) queueVolumeSave();
}

function queueVolumeSave() {
  clearTimeout(state.volumeSaveTimer);
  state.volumeSaveTimer = window.setTimeout(() => {
    state.volumeSaveTimer = null;
    setValue("appVolume", Math.round(state.volume * 100)).catch(() => {});
  }, 180);
}

function flushVolumeSave() {
  if (state.volumeSaveTimer) {
    clearTimeout(state.volumeSaveTimer);
    state.volumeSaveTimer = null;
  }
  setValue("appVolume", Math.round(state.volume * 100)).catch(() => {});
}

async function restoreAmbientNoise() {
  const [storedMode, storedVolume, storedVolumeTouched] = await Promise.all([
    getValue("ambientNoiseMode").catch(() => null),
    getValue("ambientNoiseVolume").catch(() => null),
    getValue("ambientNoiseVolumeTouched").catch(() => null),
  ]);

  // iPhoneではIndexedDBの復元が遅れ、画面を先に操作した内容を
  // 復元値が上書きすることがあります。ユーザー操作後は保存値で戻しません。
  if (state.ambientSettingsTouched) return;

  const mode = ["none", "white", "brown"].includes(storedMode)
    ? storedMode
    : DEFAULT_AMBIENT_NOISE_MODE;
  const rawVolume = storedVolume === null || storedVolume === undefined || storedVolume === ""
    ? NaN
    : Number(storedVolume);
  const storedVolumeIsValid = Number.isFinite(rawVolume) && rawVolume >= 0 && rawVolume <= 100;
  const didUserSetVolume = storedVolumeTouched === true;

  // 旧版では Number(null) が 0 になり、未設定なのに「0%」として
  // 保存されることがありました。明示的に0%を選んだ記録がない限り、
  // その値は初期値（18%）へ移行します。
  const isLegacyZero = !didUserSetVolume && rawVolume === 0;
  const nextVolume = storedVolumeIsValid && !isLegacyZero
    ? rawVolume
    : DEFAULT_AMBIENT_NOISE_VOLUME_PERCENT;

  state.ambientNoiseVolumeTouched = didUserSetVolume;
  setAmbientNoiseVolume(nextVolume, { save: false });
  setAmbientNoiseMode(mode, { save: false });
}

function handleAmbientNoiseModeControl() {
  state.ambientSettingsTouched = true;
  const nextMode = els.noiseMode.value;

  // 古いiPhone保存値の0%に当たった場合も、最初にノイズを選んだ時点で
  // 聞こえる初期値へ戻します。明示的に0%へ動かした人の設定は維持します。
  if (nextMode !== "none" && state.ambientNoiseVolume <= 0 && !state.ambientNoiseVolumeTouched) {
    setAmbientNoiseVolume(DEFAULT_AMBIENT_NOISE_VOLUME_PERCENT, { save: false });
  }

  if (nextMode === state.ambientNoiseMode) return;
  setAmbientNoiseMode(nextMode);
}

function updateAmbientNoiseControls(mode) {
  const enabled = mode !== "none";
  els.noiseMode.value = mode;
  els.ambientControl.dataset.noiseEnabled = String(enabled);
  els.ambientControl.dataset.noiseMode = mode;

  // 「なし」のときも音量を先に決めておけるように、常に操作可能にする。
  // iOS Safariでdisabled状態が選択変更後も残ることがあるためでもあります。
  els.noiseVolumeSlider.disabled = false;
  els.noiseVolumeSlider.removeAttribute("aria-disabled");
}

function handleAmbientNoiseVolumeControl() {
  state.ambientSettingsTouched = true;
  state.ambientNoiseVolumeTouched = true;
  setAmbientNoiseVolume(els.noiseVolumeSlider.value);
}

function nudgeAmbientNoiseVolume(delta) {
  state.ambientSettingsTouched = true;
  state.ambientNoiseVolumeTouched = true;
  const next = Math.round(state.ambientNoiseVolume * 100) + delta;
  setAmbientNoiseVolume(next);
  flushAmbientNoiseSave();
}

function setAmbientNoiseMode(mode, { save = true } = {}) {
  const normalized = ["none", "white", "brown"].includes(mode) ? mode : "none";
  const changed = normalized !== state.ambientNoiseMode;
  state.ambientNoiseMode = normalized;
  updateAmbientNoiseControls(normalized);
  updateSoundSettingsSummary();
  audioStore.setAmbientNoise({ mode: normalized, level: state.ambientNoiseVolume });

  if (normalized === "none") {
    audioStore.stopAmbientNoise();
  } else if (state.running && changed) {
    syncAmbientNoise({ restart: true }).catch(() => {
      setAudioRecoveryNeeded(true, "ながし音を開始できませんでした。ほかの音を止めてから「音を復帰」を押してください。");
    });
  }

  if (save) queueAmbientNoiseSave();
  updateBackgroundStatus();
}

function setAmbientNoiseVolume(percent, { save = true } = {}) {
  const parsedPercent = Number(percent);
  const normalizedPercent = clamp(
    Math.round(Number.isFinite(parsedPercent) ? parsedPercent : DEFAULT_AMBIENT_NOISE_VOLUME_PERCENT),
    0,
    100,
  );
  state.ambientNoiseVolume = normalizedPercent / 100;
  els.noiseVolumeSlider.value = String(normalizedPercent);
  els.noiseVolumeSlider.setAttribute("aria-valuenow", String(normalizedPercent));
  els.noiseVolumeSlider.setAttribute("aria-valuetext", `${normalizedPercent}%`);
  els.noiseVolumeValue.textContent = `${normalizedPercent}%`;
  audioStore.setAmbientNoise({ mode: state.ambientNoiseMode, level: state.ambientNoiseVolume });

  if (save) queueAmbientNoiseSave();
}

function queueAmbientNoiseSave() {
  clearTimeout(state.ambientNoiseSaveTimer);
  state.ambientNoiseSaveTimer = window.setTimeout(() => {
    state.ambientNoiseSaveTimer = null;
    flushAmbientNoiseSave();
  }, 180);
}

function flushAmbientNoiseSave() {
  if (state.ambientNoiseSaveTimer) {
    clearTimeout(state.ambientNoiseSaveTimer);
    state.ambientNoiseSaveTimer = null;
  }
  Promise.all([
    setValue("ambientNoiseMode", state.ambientNoiseMode),
    setValue("ambientNoiseVolume", Math.round(state.ambientNoiseVolume * 100)),
    setValue("ambientNoiseVolumeTouched", state.ambientNoiseVolumeTouched),
  ]).catch(() => {});
}

function ambientNoiseLabel() {
  if (state.ambientNoiseMode === "white") return "ホワイトノイズ";
  if (state.ambientNoiseMode === "brown") return "ブラウンノイズ";
  return "なし";
}

function updateSoundSettingsSummary() {
  if (!els.soundSettingsSummary) return;
  const voicePercent = Math.round(state.volume * 100);
  els.soundSettingsSummary.textContent = `読み上げ ${voicePercent}%・ながし音 ${ambientNoiseLabel()}`;
}

async function syncAmbientNoise({ restart = false } = {}) {
  if (!state.running || state.ambientNoiseMode === "none") {
    audioStore.stopAmbientNoise();
    return false;
  }

  const started = await audioStore.startAmbientNoise({
    mode: state.ambientNoiseMode,
    level: state.ambientNoiseVolume,
    restart,
  });

  if (!started) {
    setAudioRecoveryNeeded(true, "ながし音を再生できませんでした。ほかの音を止めてから「音を復帰」を押してください。");
  }
  return started;
}

async function restorePack() {
  const initialPackUrl = new URLSearchParams(location.search).get("pack");
  if (initialPackUrl) {
    els.packUrl.value = initialPackUrl;
    await loadPackFromUrl();
    return;
  }

  const pack = await getValue("pack");
  if (!pack) {
    syncPackLoadUI({ editorOpen: true });
    return;
  }
  state.pack = pack;
  await audioStore.loadPack(pack);
  els.packStatus.textContent = `${pack.meta?.name ?? "音声パック"} を読込済みです。開始できます。`;
  syncPackLoadUI({ editorOpen: false });
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

  // 集中画面に入る前に音の詳細を畳み、数字と操作を一画面へ収めます。
  if (els.soundSettings.open) {
    els.soundSettings.open = false;
    document.body.dataset.soundSettingsOpen = "false";
  }

  // iPhoneでは、一度止めた・閉じたあとの古い出力先が見かけ上だけ残ることがあります。
  // 開始／再開のタップごとに、音声出力を新しいユーザー操作として組み直します。
  configurePlaybackAudioSession();
  if (usesAudioGraph()) {
    const ready = await prepareAudioForUserAction({ forceRecreate: true });
    if (!ready) return;
  } else {
    resetBrowserSpeechForUserAction();
    setAudioRecoveryNeeded(false);
  }
  state.running = true;
  state.startedAt = performance.now() - state.pausedElapsed * 1000;
  state.nextFallbackSecond = Math.floor(state.pausedElapsed) + 1;
  state.scheduledUntilSecond = Math.floor(state.pausedElapsed);
  setMediaSessionState("playing");
  await requestWakeLock();
  await syncAmbientNoise({ restart: true });
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
  audioStore.stopAmbientNoise({ fadeOut: 0 });
  audioStore.pauseMediaBridge();
  audioStore.markForUserGestureReset();
  setAudioRecoveryNeeded(false);
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
  audioStore.stopAmbientNoise({ fadeOut: 0 });
  audioStore.pauseMediaBridge();
  audioStore.markForUserGestureReset();
  setAudioRecoveryNeeded(false);
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
  updateCounterUI(elapsedFloor, target);

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
  audioStore.stopAmbientNoise({ fadeOut: 0.12 });
  releaseWakeLock();
  render();

  const message = finishMessageText();
  setMediaSessionState("playing");

  // 画面が見えている通常終了では、直前に予約した音声の成否へ任せず、
  // 終了専用の2回読み上げシーケンスを今から確実に組み直す。
  if (document.visibilityState === "visible") {
    playFinishSequenceNow({ restart: true }).catch(() => {
      playBrowserFinishFallback(message);
    });
    updateBackgroundStatus(`終了しました。${message} を2回読み上げます。`);
    return;
  }

  // バックグラウンドでは、開始時に予約した2回分の音声を優先する。
  // 予約が存在しない場合だけ、フォアグラウンド復帰時に再生できるよう状態を残す。
  if (usesBufferedPack() && state.finishScheduled) {
    updateBackgroundStatus(`終了しました。${message} を2回読み上げます。`);
    if (state.finishPlayedCount >= FINISH_PLAY_COUNT) finishPlaybackAfterMessage();
    return;
  }

  playFinishSequenceNow({ restart: true }).catch(() => {
    playBrowserFinishFallback(message);
  });
  updateBackgroundStatus(`終了しました。${message} を2回読み上げます。`);
}

function elapsedSeconds() {
  if (!state.running) return state.pausedElapsed;
  return Math.max(0, (performance.now() - state.startedAt) / 1000);
}

async function scheduleAudioAhead() {
  if (!state.running || !usesBufferedPack()) return;

  if (audioStore.state !== "running") {
    setAudioRecoveryNeeded(true, "ほかの再生のあと、音声出力が止まりました。下の「音を復帰」を押すと、今の秒数から読み上げ直します。");
    return;
  }

  if (els.backgroundMode.checked && audioStore.usingMediaBridge && audioStore.mediaBridgePaused) {
    setAudioRecoveryNeeded(true, "バックグラウンド用の音声出力が一時停止しています。「音を復帰」を押すと、今の秒数から読み上げ直します。");
    return;
  }

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
  if (state.finishScheduled || state.finishPlayedCount >= FINISH_PLAY_COUNT) return;

  const message = finishMessageText();
  if (!audioStore.has(message)) return;

  const generation = state.finishGeneration;
  const finalCountValue = countValueAtSecond(target, target);
  const finalCountText = shouldSpeak(target, finalCountValue) ? cueTextForSecond(finalCountValue) : null;
  const finalCountDuration = finalCountText && audioStore.has(finalCountText)
    ? audioStore.duration(finalCountText)
    : 0;
  const firstWhen = contextNow
    + Math.max(0.05, target - scheduleFromElapsed)
    + finalCountDuration
    + FINISH_GAP_SECONDS;
  const finishDuration = audioStore.duration(message);
  const secondWhen = firstWhen + finishDuration + FINISH_REPEAT_GAP_SECONDS;

  const first = await audioStore.schedule(message, firstWhen);
  if (!first) return;
  if (generation !== state.finishGeneration) {
    cancelAudioSource(first);
    return;
  }

  const second = await audioStore.schedule(message, secondWhen);
  if (!second || generation !== state.finishGeneration) {
    cancelAudioSource(first);
    if (second) cancelAudioSource(second);
    return;
  }

  state.finishScheduled = true;
  state.finishPlayed = false;
  state.finishPlayedCount = 0;
  state.finishSource = first;
  state.finishSources.add(first);
  state.finishSources.add(second);
  rememberScheduledSource(first, true);
  rememberScheduledSource(second, true);
}

function rememberScheduledSource(source, isFinishMessage = false) {
  state.scheduledSources.add(source);
  source.addEventListener("ended", () => {
    state.scheduledSources.delete(source);
    if (!isFinishMessage || state.cancelledSources.has(source)) return;

    state.finishSources.delete(source);
    state.finishPlayedCount += 1;
    state.finishPlayed = state.finishPlayedCount >= FINISH_PLAY_COUNT;
    if (state.finishPlayed) state.finishSource = null;
    if (state.completed && !state.running && state.finishPlayed) {
      finishPlaybackAfterMessage();
    }
  }, { once: true });
}

async function playFinishSequenceNow({ restart = false, userGesture = false, includeFinalCount = true } = {}) {
  const message = finishMessageText();
  if (!usesBufferedPack() || !audioStore.has(message)) {
    playBrowserFinishFallback(message);
    return;
  }

  if (state.finishSequencePromise && !restart) return state.finishSequencePromise;
  if (restart) cancelFinishReservations();

  const generation = state.finishGeneration;
  const job = (async () => {
    if (userGesture) {
      await audioStore.resumeForUserGesture({ preferMediaElement: Boolean(els.backgroundMode.checked) });
    } else {
      await audioStore.ensureContext({ resume: true, preferMediaElement: Boolean(els.backgroundMode.checked) });
    }

    if (generation !== state.finishGeneration) return;

    const target = targetSeconds();
    const finalCountValue = countValueAtSecond(target, target);
    const finalCountText = includeFinalCount && shouldSpeak(target, finalCountValue)
      ? cueTextForSecond(finalCountValue)
      : null;
    const finalCountDuration = finalCountText && audioStore.has(finalCountText)
      ? audioStore.duration(finalCountText)
      : 0;
    const messageDuration = audioStore.duration(message);
    const firstWhen = audioStore.currentTime + Math.max(0.06, finalCountDuration + FINISH_GAP_SECONDS);
    const secondWhen = firstWhen + messageDuration + FINISH_REPEAT_GAP_SECONDS;

    const first = await audioStore.schedule(message, firstWhen);
    if (!first || generation !== state.finishGeneration) {
      if (first) cancelAudioSource(first);
      return;
    }

    const second = await audioStore.schedule(message, secondWhen);
    if (!second || generation !== state.finishGeneration) {
      cancelAudioSource(first);
      if (second) cancelAudioSource(second);
      return;
    }

    state.finishScheduled = true;
    state.finishPlayed = false;
    state.finishPlayedCount = 0;
    state.finishSource = first;
    state.finishSources.add(first);
    state.finishSources.add(second);
    rememberScheduledSource(first, true);
    rememberScheduledSource(second, true);
  })();

  state.finishSequencePromise = job;
  try {
    await job;
  } finally {
    if (state.finishSequencePromise === job) state.finishSequencePromise = null;
  }
}

function playBrowserFinishFallback(message) {
  if (els.audioSource.value === "silent") return;
  browserSpeak(message);
  window.setTimeout(() => browserSpeak(message), 1550);
  deferFinishPlayback(3600);
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

function cancelAudioSource(source) {
  if (!source) return;
  state.cancelledSources.add(source);
  try { source.stop(); } catch { /* already ended */ }
}

function cancelFinishReservations() {
  state.finishGeneration += 1;
  for (const source of state.finishSources) {
    cancelAudioSource(source);
    state.scheduledSources.delete(source);
  }
  state.finishSources.clear();
  state.finishScheduled = false;
  state.finishPlayed = false;
  state.finishPlayedCount = 0;
  state.finishSource = null;
}

function stopScheduledAudio() {
  clearTimeout(state.finishCleanupTimer);
  state.finishCleanupTimer = null;
  state.finishSequencePromise = null;
  state.finishGeneration += 1;

  for (const source of state.scheduledSources) {
    cancelAudioSource(source);
  }
  state.scheduledSources.clear();
  state.finishSources.clear();
  state.finishSource = null;
  state.finishScheduled = false;
  state.finishPlayed = false;
  state.finishPlayedCount = 0;
}

function clearFinishState() {
  clearTimeout(state.finishCleanupTimer);
  state.finishCleanupTimer = null;
  state.finishSequencePromise = null;
  cancelFinishReservations();
}

async function handleVisibilityChange() {
  if (document.visibilityState === "hidden") {
    // バックグラウンド復帰後は、次のユーザー操作で出力先を作り直す。
    // 予約済みの音声はそのまま活かし、復帰時に実際に止まっていた場合だけ案内する。
    if (usesAudioGraph()) audioStore.markForUserGestureReset({ hard: true });
    return;
  }
  await handleReturnToApp();
}

function handlePageHide() {
  flushVolumeSave();
  flushAmbientNoiseSave();
  if (usesAudioGraph()) audioStore.markForUserGestureReset({ hard: true });
  if (!state.running) stopScheduledAudio();
}

async function handleReturnToApp() {
  if (!state.running) {
    if (state.completed && usesAudioGraph() && (audioStore.state !== "running" || audioStore.mediaBridgePaused)) {
      setAudioRecoveryNeeded(true, "終了音声が止まっているかもしれません。「音を復帰」を押すと、終了メッセージを2回読み上げます。");
    }
    return;
  }

  await requestWakeLock();

  if (!usesAudioGraph()) {
    resumeBrowserSpeech();
    tick();
    return;
  }

  const bridgeStopped = els.backgroundMode.checked && audioStore.usingMediaBridge && audioStore.mediaBridgePaused;
  if (audioStore.state !== "running" || bridgeStopped) {
    setAudioRecoveryNeeded(true, "アプリを戻したあと音声出力が止まっています。下の「音を復帰」を押すと、今の秒数から読み上げ直します。");
    tick();
    return;
  }

  await rescheduleAudioFromCurrentPosition();
  tick();
}

async function rescheduleRunningAudio() {
  updateBackgroundStatus();
  if (!state.running) return;

  if (usesAudioGraph() && (audioStore.state !== "running" || (els.backgroundMode.checked && audioStore.usingMediaBridge && audioStore.mediaBridgePaused))) {
    setAudioRecoveryNeeded(true, "音声の出力が止まっています。「音を復帰」を押すと、今の秒数から読み上げ直します。");
    return;
  }

  await rescheduleAudioFromCurrentPosition();
}


function bindAudioRecoverySignals() {
  audioStore.onContextStateChange(({ state: contextState }) => {
    if (!state.running || !usesAudioGraph()) return;

    if (contextState !== "running") {
      setAudioRecoveryNeeded(true, "ほかの再生によって音声が一時停止しました。ほかの音を止めてから「音を復帰」を押してください。");
      return;
    }

    if (state.audioNeedsRecovery) {
      rescheduleAudioFromCurrentPosition({ clearRecovery: true }).catch(() => {
        setAudioRecoveryNeeded(true, "音声を再接続できませんでした。「音を復帰」をもう一度押してください。");
      });
    }
  });

  audioStore.onMediaBridgeEvent(({ type }) => {
    if (!state.running || !usesAudioGraph() || !els.backgroundMode.checked || !audioStore.usingMediaBridge) return;

    if (type === "pause" || type === "ended") {
      setAudioRecoveryNeeded(true, "ほかの再生で音声出力が止まりました。ほかの音を止めてから「音を復帰」を押してください。");
      return;
    }

    if (type === "playing" && state.audioNeedsRecovery && audioStore.state === "running") {
      rescheduleAudioFromCurrentPosition({ clearRecovery: true }).catch(() => {});
    }
  });
}

async function prepareAudioForUserAction({ forceRecreate = false } = {}) {
  try {
    configurePlaybackAudioSession();
    await audioStore.resumeForUserGesture({
      preferMediaElement: Boolean(els.backgroundMode.checked),
      forceRecreate: Boolean(forceRecreate || audioStore.needsUserGestureReset),
    });
    if (!state.running) setAudioRecoveryNeeded(false);
    return true;
  } catch {
    setAudioRecoveryNeeded(true, "音声を再開できませんでした。ほかの音を止めてから「音を復帰」を押してください。");
    updateBackgroundStatus("音声の開始を許可できませんでした。ほかの再生を止めてから、もう一度「開始」または「音を復帰」を押してください。");
    return false;
  }
}

async function recoverAudioFromUserAction() {
  if (state.audioRecoveryInFlight) return;
  state.audioRecoveryInFlight = true;
  els.resumeAudioBtn.disabled = true;
  els.resumeAudioBtn.textContent = "復帰中…";

  try {
    if (usesAudioGraph()) {
      // ユーザーが押した復帰ボタンでは、必ず古い出力先を捨てて再構築する。
      stopScheduledAudio();
      const ready = await prepareAudioForUserAction({ forceRecreate: true });
      if (!ready) return;
      if (state.running) {
        await rescheduleAudioFromCurrentPosition({ clearRecovery: true });
      } else if (state.completed) {
        await playFinishSequenceNow({ restart: true, userGesture: true });
        setAudioRecoveryNeeded(false);
      }
    } else {
      resetBrowserSpeechForUserAction();
      if (state.completed) playBrowserFinishFallback(finishMessageText());
      setAudioRecoveryNeeded(false);
    }

    updateBackgroundStatus(state.running
      ? "音を復帰しました。今の秒数から読み上げ直します。"
      : state.completed
        ? "終了メッセージを2回、もう一度読み上げます。"
        : "音を復帰しました。開始すると音声を再生します。");
  } finally {
    state.audioRecoveryInFlight = false;
    els.resumeAudioBtn.disabled = false;
    els.resumeAudioBtn.textContent = "音を復帰";
  }
}

async function rescheduleAudioFromCurrentPosition({ clearRecovery = false } = {}) {
  if (!state.running) return;
  if (state.audioReschedulePromise) return state.audioReschedulePromise;

  const job = (async () => {
    stopScheduledAudio();
    state.scheduledUntilSecond = Math.floor(elapsedSeconds());
    state.nextFallbackSecond = state.scheduledUntilSecond + 1;

    await syncAmbientNoise({ restart: true });

    if (usesBufferedPack()) {
      await scheduleAudioAhead();
    } else {
      resumeBrowserSpeech();
    }

    if (clearRecovery && audioStore.state === "running" && (!els.backgroundMode.checked || !audioStore.mediaBridgePaused)) {
      setAudioRecoveryNeeded(false);
    }
  })();

  state.audioReschedulePromise = job;
  try {
    await job;
  } finally {
    if (state.audioReschedulePromise === job) state.audioReschedulePromise = null;
  }
}

function setAudioRecoveryNeeded(needsRecovery, message = "") {
  state.audioNeedsRecovery = Boolean(needsRecovery);
  els.audioRecovery.hidden = !state.audioNeedsRecovery;
  document.body.dataset.audioRecovery = String(state.audioNeedsRecovery);

  if (state.audioNeedsRecovery) {
    els.audioRecoveryMessage.textContent = message || "音声が止まった場合は、ほかの再生を止めてから「音を復帰」を押してください。";
  }
}

function resumeBrowserSpeech() {
  if (!("speechSynthesis" in window)) return;
  try { speechSynthesis.resume(); } catch { /* optional */ }
}

function resetBrowserSpeechForUserAction() {
  if (!("speechSynthesis" in window)) return;
  try { speechSynthesis.cancel(); } catch { /* optional */ }
  resumeBrowserSpeech();
}

function usesAudioGraph() {
  return usesBufferedPack() || state.ambientNoiseMode !== "none";
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
    await audioStore.resumeForUserGesture({
      preferMediaElement: Boolean(els.backgroundMode.checked),
      forceRecreate: true,
    });
    await audioStore.play("1");
    return;
  }
  resetBrowserSpeechForUserAction();
  await speakCueNow("1");
}

async function playFinishTest() {
  const message = finishMessageText();
  if (usesBufferedPack() && audioStore.has(message)) {
    await audioStore.resumeForUserGesture({
      preferMediaElement: Boolean(els.backgroundMode.checked),
      forceRecreate: true,
    });
    await playFinishSequenceNow({ restart: true, userGesture: false, includeFinalCount: false });
    return;
  }
  resetBrowserSpeechForUserAction();
  playBrowserFinishFallback(message);
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
  resumeBrowserSpeech();
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(String(text));
  utterance.lang = "ja-JP";
  utterance.rate = 1.2;
  utterance.volume = state.volume;
  speechSynthesis.speak(utterance);
}

function packDisplayName(pack) {
  const raw = String(pack?.meta?.name ?? "").trim();
  if (!raw) return "ずんだボイス";
  return raw.length > 28 ? `${raw.slice(0, 27)}…` : raw;
}

function syncPackLoadUI({ editorOpen } = {}) {
  const loaded = Boolean(state.pack);
  const previous = els.quickLoadCard.dataset.editorOpen === "true";
  const open = typeof editorOpen === "boolean" ? editorOpen : (loaded ? previous : true);

  els.quickLoadCard.dataset.packState = loaded ? "ready" : "empty";
  els.quickLoadCard.dataset.editorOpen = String(open);
  els.packReadyName.textContent = packDisplayName(state.pack);
  els.togglePackEditorBtn.setAttribute("aria-expanded", String(open));
  els.togglePackEditorBtn.textContent = open ? "閉じる" : "URLを変更";
  document.body.dataset.packReady = String(loaded);
}

function togglePackEditor() {
  const currentlyOpen = els.quickLoadCard.dataset.editorOpen === "true";
  const nextOpen = !currentlyOpen;
  syncPackLoadUI({ editorOpen: nextOpen });
  if (nextOpen) {
    requestAnimationFrame(() => els.packUrl.focus());
  }
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
    els.quickLoadCard.dataset.loading = "true";
    els.loadPackUrlBtn.disabled = true;
    els.reloadPackBtn.disabled = true;
    els.packStatus.textContent = "URLから音声パックを読み込んでいます...";
    const response = await fetch(rawUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const pack = JSON.parse(await response.text());
    await saveLoadedPack(pack);
    els.packStatus.textContent = `${pack.meta?.name ?? "音声パック"} をURLから読み込みました。開始できます。`;
    syncPackLoadUI({ editorOpen: false });
  } catch {
    syncPackLoadUI({ editorOpen: true });
    els.packStatus.textContent = "URLからPONVOICEを読み込めませんでした。同じサイト内のURLか、CORS許可されたURLを指定してください。";
  } finally {
    delete els.quickLoadCard.dataset.loading;
    els.loadPackUrlBtn.disabled = false;
    els.reloadPackBtn.disabled = false;
  }
}

async function saveLoadedPack(pack) {
  validatePack(pack);
  state.pack = pack;
  await setValue("pack", pack);
  await audioStore.loadPack(pack);
  els.audioSource.value = "pack";
  syncPackLoadUI({ editorOpen: false });
  updateFinishMessageUI();
  updateBackgroundStatus();
}

async function clearPack() {
  state.pack = null;
  stopScheduledAudio();
  audioStore.buffers.clear();
  await deleteValue("pack");
  els.packStatus.textContent = "音声パックは未読込です。上の「URLから読み込む」から開始できます。";
  syncPackLoadUI({ editorOpen: true });
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
  const raw = els.engineUrl.value.trim() || "./voicevox";
  return new URL(raw, location.href).href.replace(/\/$/, "");
}

function render() {
  const target = targetSeconds();
  const elapsed = Math.min(Math.floor(elapsedSeconds()), target);
  updateCounterUI(elapsed, target);
  els.startBtn.textContent = state.completed ? "もう一度開始" : state.pausedElapsed > 0 ? "再開" : "開始";
  els.pauseBtn.disabled = !state.running;
  els.resetBtn.disabled = !state.running && state.pausedElapsed === 0 && !state.completed;
  updateTargetCopy();
}

function updateCounterUI(elapsed, target) {
  const visible = visibleValue(elapsed, target);
  const mode = els.mode.value;
  const viewState = state.completed
    ? "completed"
    : state.running
      ? "running"
      : state.pausedElapsed > 0
        ? "paused"
        : "stopped";

  document.body.dataset.appState = viewState;
  els.modeLabel.textContent = mode === "down" ? "カウントダウン" : "カウントアップ";
  els.unitLabel.textContent = "HH:MM:SS";
  els.countDisplay.textContent = formatClock(visible);
  els.countDisplay.setAttribute("aria-label", timerAriaLabel(visible));
  els.sessionProgress.max = target;
  els.sessionProgress.value = Math.min(elapsed, target);
  els.sessionProgress.setAttribute("aria-valuetext", `${Math.min(elapsed, target)}秒 / ${target}秒`);
  els.targetSummary.textContent = mode === "down"
    ? `スタート ${formatDuration(target)}`
    : `ゴールまで ${formatDuration(target)}`;
  els.countState.textContent = statePillCopy(viewState);
  els.cheerMessage.textContent = cheerCopy(viewState, elapsed, target);
}

function statePillCopy(viewState) {
  if (viewState === "completed") return "時間になったのだ！";
  if (viewState === "running") return "数えているのだ";
  if (viewState === "paused") return "ひと休みなのだ";
  return "準備OKなのだ";
}

function cheerCopy(viewState, elapsed, target) {
  if (viewState === "completed") return "時間になったのだ！ おつかれさまなのだ。";
  if (viewState === "paused") return "ひと休みして、また戻ってくればいいのだ。";
  if (viewState === "stopped") return "準備OKなのだ。自分のペースでいこう。";

  const progress = target ? elapsed / target : 0;
  if (progress < 0.25) return "いいスタートなのだ。焦らず数えていこう。";
  if (progress < 0.75) return "いいペースなのだ。そのままいこう。";
  return "もうひと息なのだ。ゴールはすぐそこ。";
}

function targetSeconds() {
  return clamp(Number(els.targetSeconds.value) || 900, 1, 86400);
}

function countValueAtSecond(second, target) {
  return els.mode.value === "down" ? Math.max(0, target - second) : Math.min(target, second);
}

function visibleValue(elapsed, target) {
  return els.mode.value === "down" ? Math.max(0, target - elapsed) : Math.min(target, elapsed);
}

function timerAriaLabel(value) {
  return `${els.mode.value === "down" ? "残り" : "経過"} ${formatClockSpeech(value)}`;
}

function formatClock(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remain = seconds % 60;
  return [hours, minutes, remain]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function formatClockSpeech(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remain = seconds % 60;
  return `${hours}時間${minutes}分${remain}秒`;
}

function updateTargetCopy() {
  const duration = formatDuration(targetSeconds());
  if (els.mode.value === "up") {
    els.targetSecondsLabel.textContent = "終了まで（秒）";
    els.targetSecondsHint.textContent = `${duration}で自動終了します。例：300秒 = 5分`;
  } else {
    els.targetSecondsLabel.textContent = "開始時間（秒）";
    els.targetSecondsHint.textContent = `${duration}から開始し、0秒で終了します。`;
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
    els.finishMessageStatus.textContent = "この音声パックには、終了メッセージの音声が入っています。終了時に2回読み上げます。";
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
  updateBackgroundStatus(`終了しました。${finishMessageText()} を2回読み上げました。`);
}

function updateBackgroundStatus(message = "") {
  if (message) {
    els.backgroundStatus.textContent = message;
    return;
  }

  if (state.audioNeedsRecovery) {
    els.backgroundStatus.textContent = "ほかの再生のあと音声が止まりました。ほかの音を止めてから、操作の近くに出る「音を復帰」を押してください。";
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
  const ambientNote = state.ambientNoiseMode === "none"
    ? "ながし音はなしです。"
    : `ながし音は${ambientNoiseLabel()}（${Math.round(state.ambientNoiseVolume * 100)}%）です。`;

  if (state.running) {
    els.backgroundStatus.textContent = `${sessionReady ? "再生セッションを設定し、" : "再生セッション非対応のため、"}${BACKGROUND_LOOKAHEAD_SECONDS / 60}分先まで音声と終了メッセージを予約中です${bridgeReady ? "。" : "（端末側のメディア再生を利用できない場合があります）。"} ${ambientNote}`;
    return;
  }

  els.backgroundStatus.textContent = `開始時に${BACKGROUND_LOOKAHEAD_SECONDS / 60}分先まで音声を予約します。ほかの再生で止まった場合は、操作の近くの「音を復帰」で読み上げを戻せます。 ${ambientNote}`;
}

function hasFinishAudio() {
  return Boolean(state.pack) && audioStore.has(finishMessageText());
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
