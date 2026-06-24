import { AudioStore, arrayBufferToBase64 } from "./audio.js?v=8";
import { cueTextForSecond, cueTextsForPack } from "./count-format.js?v=8";
import { deleteValue, getValue, setValue } from "./db.js?v=8";

const audioStore = new AudioStore();
const state = {
  running: false,
  startedAt: 0,
  pausedElapsed: 0,
  nextSecond: 1,
  timerId: null,
  pack: null,
  speakers: [],
  selectedStyleId: null,
  wakeLock: null,
};

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

init();

async function init() {
  bindEvents();
  await restorePack();
  render();
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
  els.packInput.addEventListener("change", importPack);
  els.loadPackUrlBtn.addEventListener("click", loadPackFromUrl);
  els.clearPackBtn.addEventListener("click", clearPack);
  els.testVoiceBtn.addEventListener("click", () => speakCue("1"));
  els.connectBtn.addEventListener("click", connectVoicevox);
  els.prepareBtn.addEventListener("click", prepareVoicevoxClips);
  document.addEventListener("visibilitychange", handleVisibilityChange);
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
  els.packStatus.textContent = `${pack.meta?.name ?? "音声パック"} を読込済みです。`;
}

async function start() {
  if (els.audioSource.value !== "silent" && els.audioSource.value !== "browser") {
    await audioStore.ensureContext();
  }
  if (state.running) return;
  state.running = true;
  state.startedAt = Date.now() - state.pausedElapsed * 1000;
  state.nextSecond = Math.floor(state.pausedElapsed) + 1;
  await requestWakeLock();
  tick();
}

function pause() {
  state.pausedElapsed = elapsedSeconds();
  state.running = false;
  clearTimeout(state.timerId);
  releaseWakeLock();
  render();
}

function reset() {
  state.running = false;
  clearTimeout(state.timerId);
  state.pausedElapsed = 0;
  state.nextSecond = 1;
  releaseWakeLock();
  render();
}

function tick() {
  if (!state.running) return;
  const elapsed = elapsedSeconds();
  const target = targetSeconds();
  const elapsedFloor = Math.floor(elapsed);
  if (elapsedFloor - state.nextSecond > 3) {
    state.nextSecond = elapsedFloor;
  }
  const visible = els.mode.value === "down" ? Math.max(0, target - Math.floor(elapsed)) : Math.floor(elapsed);
  els.countDisplay.textContent = visible;

  while (state.nextSecond <= elapsedFloor) {
    const countValue = els.mode.value === "down" ? Math.max(0, target - state.nextSecond) : state.nextSecond;
    if (shouldSpeak(state.nextSecond, countValue)) {
      speakCue(cueTextForSecond(countValue));
    }
    state.nextSecond += 1;
  }

  if (els.mode.value === "down" && elapsed >= target) {
    state.running = false;
    state.pausedElapsed = target;
    speakCue("0");
    render();
    return;
  }

  state.timerId = setTimeout(tick, 80);
}

function elapsedSeconds() {
  if (!state.running) return state.pausedElapsed;
  return Math.max(0, (Date.now() - state.startedAt) / 1000);
}

async function handleVisibilityChange() {
  if (!state.running) return;
  if (document.visibilityState === "visible") {
    state.nextSecond = Math.max(state.nextSecond, Math.floor(elapsedSeconds()));
    await requestWakeLock();
    tick();
  } else {
    clearTimeout(state.timerId);
  }
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
    });
  } catch {
    state.wakeLock = null;
  }
}

function releaseWakeLock() {
  if (!state.wakeLock) return;
  state.wakeLock.release().catch(() => {});
  state.wakeLock = null;
}

function targetSeconds() {
  return clamp(Number(els.targetSeconds.value) || 60, 1, 86400);
}

function shouldSpeak(second, countValue) {
  const interval = Number(els.intervalSeconds.value) || 1;
  return second % interval === 0 || countValue === 0;
}

async function speakCue(text) {
  if (els.audioSource.value === "silent") return;
  const key = String(text);
  if (els.audioSource.value === "pack" || els.audioSource.value === "voicevox") {
    const played = await audioStore.play(key);
    if (played) return;
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
    els.packStatus.textContent = `${pack.meta?.name ?? file.name} を取り込みました。`;
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
    els.packStatus.textContent = "URLから音声パックを読み込んでいます...";
    const response = await fetch(rawUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const pack = JSON.parse(await response.text());
    await saveLoadedPack(pack);
    els.packStatus.textContent = `${pack.meta?.name ?? "音声パック"} をURLから読み込みました。`;
  } catch {
    els.packStatus.textContent = "URLからPONVOICEを読み込めませんでした。同じサイト内のURLか、CORS許可されたURLを指定してください。";
  }
}

async function saveLoadedPack(pack) {
  validatePack(pack);
  state.pack = pack;
  await setValue("pack", pack);
  await audioStore.loadPack(pack);
  els.audioSource.value = "pack";
}

async function clearPack() {
  state.pack = null;
  audioStore.buffers.clear();
  await deleteValue("pack");
  els.packStatus.textContent = "音声パックは未読込です。";
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
      if (speaker.name.includes("ずんだもん") && style.name.includes("ノーマル")) {
        option.selected = true;
      }
      els.speakerSelect.append(option);
    }
  }
  state.selectedStyleId = Number(els.speakerSelect.value);
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
  state.pack = pack;
  await setValue("pack", pack);
  els.audioSource.value = "voicevox";
  els.packStatus.textContent = "0〜59秒の音声を準備しました。";
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
  const query = await fetchJson(`${baseUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`, {
    method: "POST",
  });
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
  els.modeLabel.textContent = els.mode.value === "down" ? "カウントダウン" : "カウントアップ";
  els.unitLabel.textContent = "秒";
  els.countDisplay.textContent = els.mode.value === "down" ? Math.max(0, target - elapsed) : elapsed;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
