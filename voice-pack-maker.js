import { arrayBufferToBase64 } from "./audio.js";
import { DEFAULT_FINISH_MESSAGE, cueTextsForPack, normalizeFinishMessage } from "./count-format.js";

const $ = (id) => document.getElementById(id);
const els = {
  engineUrl: $("engineUrl"),
  connectBtn: $("connectBtn"),
  speakerSelect: $("speakerSelect"),
  packSize: $("packSize"),
  speedScale: $("speedScale"),
  finishMessage: $("finishMessage"),
  finishPreview: $("finishPreview"),
  fileName: $("fileName"),
  createBtn: $("createBtn"),
  testBtn: $("testBtn"),
  testFinishBtn: $("testFinishBtn"),
  stopBtn: $("stopBtn"),
  progress: $("progress"),
  progressText: $("progressText"),
  status: $("status"),
  diagnoseBtn: $("diagnoseBtn"),
  diagnosticOutput: $("diagnosticOutput"),
};

let abort = false;
let audio = new Audio();

els.connectBtn.addEventListener("click", connect);
els.diagnoseBtn.addEventListener("click", diagnoseConnection);
els.createBtn.addEventListener("click", createPack);
els.testBtn.addEventListener("click", () => testVoice("1"));
els.testFinishBtn.addEventListener("click", () => testVoice(finishMessage()));
els.stopBtn.addEventListener("click", () => {
  abort = true;
  audio.pause();
});
els.packSize.addEventListener("change", updateMax);
els.finishMessage.addEventListener("input", () => {
  renderFinishPreview();
  updateMax();
});

renderFinishPreview();
updateMax();
renderOriginHint();
if (new URLSearchParams(location.search).has("diagnose")) diagnoseConnection();

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
    els.status.textContent = `接続しました。${speakers.length}人分の話者情報を読み込みました。`;
    els.diagnosticOutput.textContent = `接続成功
ページ: ${currentOriginLabel()}
Engine: ${baseUrl()}
話者: ${speakers.length}人`;
    return true;
  } catch (error) {
    els.status.textContent = connectionFailureMessage(error);
    els.diagnosticOutput.textContent = diagnosticFailureDetail(error);
    return false;
  }
}

function renderOriginHint() {
  const origin = currentOriginLabel();
  const local = isLocalPage();
  els.diagnosticOutput.textContent = `${local ? "ローカル作成モードです。接続診断を押してください。" : "このページは公開URLまたはfile://で開かれています。VOICEVOX接続はローカル作成モードを使ってください。"}
ページ: ${origin}
Engine: ${baseUrl()}`;
}

async function diagnoseConnection() {
  const local = isLocalPage();
  els.diagnosticOutput.textContent = `診断中...
ページ: ${currentOriginLabel()}
Engine: ${baseUrl()}`;

  if (!local) {
    els.diagnosticOutput.textContent = [
      "この画面はPCローカルで開かれていません。",
      `現在のページ: ${currentOriginLabel()}`,
      "公開URL・スマホ・file:// からVOICEVOXへ接続すると、CORSまたはブラウザ制限で失敗しやすくなります。",
      "対処: このフォルダ内の START_HERE.bat をダブルクリックし、",
      "自動で開いた http://127.0.0.1:8786/voice-pack-maker.html で接続してください。",
    ].join("\n");
    return;
  }

  try {
    const response = await fetch(`${baseUrl()}/speakers`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const speakers = await response.json();
    els.diagnosticOutput.textContent = [
      "接続診断: 成功",
      `ページ: ${currentOriginLabel()}`,
      `Engine: ${baseUrl()}`,
      `話者情報: ${speakers.length}人分を取得`,
      "このまま「接続」を押してください。",
    ].join("\n");
  } catch (error) {
    els.diagnosticOutput.textContent = diagnosticFailureDetail(error);
  }
}

function currentOriginLabel() {
  return location.origin === "null" ? "file://（直接開き）" : location.origin;
}

function isLocalPage() {
  return location.protocol !== "file:" && ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
}

function connectionFailureMessage(error) {
  if (!isLocalPage()) {
    return "接続できません。公開URLやfile://ではなく、start-voice-pack-maker.batで開いたPCローカル画面から接続してください。";
  }
  return `接続できません。VOICEVOX API（${baseUrl()}）へ到達できませんでした。接続診断で詳細を確認してください。`;
}

function diagnosticFailureDetail(error) {
  const message = error?.message || String(error);
  if (!isLocalPage()) {
    return [
      "接続診断: ページの開き方が原因です。",
      `現在のページ: ${currentOriginLabel()}`,
      "VOICEVOXは外部サイトからの接続を初期状態では拒否します。",
      "このフォルダの start-voice-pack-maker.bat をダブルクリックして、",
      "http://127.0.0.1:8786/voice-pack-maker.html を開いてください。",
      `参考エラー: ${message}`,
    ].join("\n");
  }
  return [
    "接続診断: VOICEVOX Engineへ到達できません。",
    `ページ: ${currentOriginLabel()}`,
    `接続先: ${baseUrl()}`,
    `ブラウザのエラー: ${message}`,
    "確認: ① http://127.0.0.1:50021/docs が開くか ② VOICEVOXを完全に再起動 ③ Windowsファイアウォールの許可", 
  ].join("\n");
}

async function createPack() {
  if (!els.speakerSelect.value && !(await connect())) return;

  abort = false;
  const finish = finishMessage();
  const texts = textsForPack();
  const clips = {};
  els.progress.max = texts.length;
  els.progress.value = 0;

  for (const [index, text] of texts.entries()) {
    if (abort) {
      els.progressText.textContent = "停止しました。途中までのパックは保存されません。";
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
    version: 2,
    meta: {
      name: els.fileName.value.replace(/\.ponvoice$/i, ""),
      createdAt: new Date().toISOString(),
      packSize: els.packSize.value,
      speakerStyleId: Number(els.speakerSelect.value),
      speedScale: Number(els.speedScale.value),
      finishMessage: finish,
      credit: selectedCredit(),
    },
    clips,
  };

  downloadJson(pack, safeFileName(els.fileName.value));
  els.progressText.textContent = `保存しました。終了メッセージ「${finish}」も含まれています。`;
}

async function testVoice(text) {
  if (!els.speakerSelect.value && !(await connect())) return;
  const buffer = await synthesize(text).catch(() => null);
  if (!buffer) {
    els.progressText.textContent = "試聴できませんでした。";
    return;
  }

  audio.pause();
  if (audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src);
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
  return cueTextsForPack(els.packSize.value, finishMessage());
}

function finishMessage() {
  return normalizeFinishMessage(els.finishMessage.value || DEFAULT_FINISH_MESSAGE);
}

function selectedCredit() {
  const label = els.speakerSelect.selectedOptions[0]?.textContent ?? "";
  const speakerName = label.split(" /")[0].trim();
  return speakerName ? `VOICEVOX: ${speakerName}` : "VOICEVOX";
}

function renderFinishPreview() {
  els.finishPreview.textContent = `「${finishMessage()}」`;
}

function updateMax() {
  els.progress.max = textsForPack().length;
  els.progress.value = 0;
}

function baseUrl() {
  const raw = els.engineUrl.value.trim() || "./voicevox";
  return new URL(raw, location.href).href.replace(/\/$/, "");
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
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function safeFileName(value) {
  const name = value || "poncount__voicevox__standard__end-message__v02.ponvoice";
  const safe = name.replace(/[\\/:*?"<>|]/g, "_").replace(/\.json$/i, ".ponvoice");
  return /\.ponvoice$/i.test(safe) ? safe : `${safe}.ponvoice`;
}
