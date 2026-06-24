import { arrayBufferToBase64 } from "./audio.js?v=8";
import { cueTextsForPack } from "./count-format.js?v=8";

const $ = (id) => document.getElementById(id);
const els = {
  engineUrl: $("engineUrl"),
  connectBtn: $("connectBtn"),
  speakerSelect: $("speakerSelect"),
  packSize: $("packSize"),
  speedScale: $("speedScale"),
  fileName: $("fileName"),
  createBtn: $("createBtn"),
  testBtn: $("testBtn"),
  stopBtn: $("stopBtn"),
  progress: $("progress"),
  progressText: $("progressText"),
  status: $("status"),
};

let abort = false;
let audio = new Audio();

els.connectBtn.addEventListener("click", connect);
els.createBtn.addEventListener("click", createPack);
els.testBtn.addEventListener("click", testVoice);
els.stopBtn.addEventListener("click", () => {
  abort = true;
  audio.pause();
});
els.packSize.addEventListener("change", updateMax);

updateMax();

async function connect() {
  els.status.textContent = "接続中...";
  try {
    const speakers = await fetchJson(`${baseUrl()}/speakers`);
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
    els.status.textContent = "接続しました。";
    return true;
  } catch {
    els.status.textContent = "接続できませんでした。VOICEVOX Engineを起動してください。";
    return false;
  }
}

async function createPack() {
  if (!els.speakerSelect.value && !(await connect())) return;
  abort = false;
  const texts = textsForPack();
  const clips = {};
  els.progress.max = texts.length;
  els.progress.value = 0;
  for (const [index, text] of texts.entries()) {
    if (abort) {
      els.progressText.textContent = "停止しました。";
      return;
    }
    els.progressText.textContent = `${index + 1}/${texts.length}: ${text}`;
    let buffer;
    try {
      buffer = await synthesize(text);
    } catch {
      els.progressText.textContent = "音声作成に失敗しました。VOICEVOXの起動状態を確認してください。";
      return;
    }
    clips[text] = arrayBufferToBase64(buffer);
    els.progress.value = index + 1;
  }
  const pack = {
    kind: "ponvoice",
    version: 1,
    meta: {
      name: els.fileName.value.replace(/\.ponvoice$/i, ""),
      createdAt: new Date().toISOString(),
      packSize: els.packSize.value,
      speakerStyleId: Number(els.speakerSelect.value),
      speedScale: Number(els.speedScale.value),
      credit: "VOICEVOX",
    },
    clips,
  };
  downloadJson(pack, safeFileName(els.fileName.value));
  els.progressText.textContent = "保存しました。";
}

async function testVoice() {
  if (!els.speakerSelect.value && !(await connect())) return;
  const buffer = await synthesize("1").catch(() => null);
  if (!buffer) {
    els.progressText.textContent = "試聴できませんでした。";
    return;
  }
  const blob = new Blob([buffer], { type: "audio/wav" });
  audio.src = URL.createObjectURL(blob);
  await audio.play().catch(() => {
    els.progressText.textContent = "試聴音声を作成しました。ブラウザが再生を止めた場合は、もう一度試聴を押してください。";
  });
}

async function synthesize(text) {
  const speaker = Number(els.speakerSelect.value);
  const query = await fetchJson(`${baseUrl()}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`, {
    method: "POST",
  });
  query.speedScale = Number(els.speedScale.value);
  query.prePhonemeLength = 0.08;
  query.postPhonemeLength = 0.08;
  const response = await fetch(`${baseUrl()}/synthesis?speaker=${speaker}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query),
  });
  if (!response.ok) throw new Error("音声作成に失敗しました。");
  return response.arrayBuffer();
}

function textsForPack() {
  return cueTextsForPack(els.packSize.value);
}

function updateMax() {
  els.progress.max = textsForPack().length;
  els.progress.value = 0;
}

function baseUrl() {
  return els.engineUrl.value.replace(/\/$/, "");
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function downloadJson(data, fileName) {
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function safeFileName(value) {
  const name = value || "poncount__voicevox__standard__v01.ponvoice";
  const safe = name.replace(/[\\/:*?"<>|]/g, "_").replace(/\.json$/i, ".ponvoice");
  return /\.ponvoice$/i.test(safe) ? safe : `${safe}.ponvoice`;
}
