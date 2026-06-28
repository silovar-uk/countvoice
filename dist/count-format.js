export const DEFAULT_FINISH_MESSAGE = "時間になったのだ";

export function normalizeFinishMessage(value) {
  const text = String(value ?? "").trim();
  return text || DEFAULT_FINISH_MESSAGE;
}

export function cueTextForSecond(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds === 0) return "0";

  if (seconds % 3600 === 0) {
    return `${seconds / 3600}時間`;
  }

  if (seconds % 60 === 0) {
    return `${Math.floor(seconds / 60)}分`;
  }

  const secondInMinute = seconds % 60;
  if (secondInMinute % 10 === 0) {
    return `${secondInMinute}秒`;
  }

  return String(secondInMinute % 10);
}

export function cueTextsForPack(packSize, finishMessage = DEFAULT_FINISH_MESSAGE) {
  const cues = new Set(["0"]);

  for (let i = 1; i <= 9; i += 1) cues.add(String(i));
  for (const second of [10, 20, 30, 40, 50]) cues.add(`${second}秒`);

  if (packSize === "core") {
    cues.add("1分");
  } else {
    for (let minute = 1; minute <= 59; minute += 1) {
      cues.add(`${minute}分`);
    }
    cues.add("1時間");

    if (packSize === "full") {
      for (let hour = 2; hour <= 24; hour += 1) {
        cues.add(`${hour}時間`);
      }
    }
  }

  // 終了時のセリフもパックへ収録。iPhoneのバックグラウンド再生時も
  // その場で音声合成を待たず、予約再生できます。
  cues.add(normalizeFinishMessage(finishMessage));

  return [...cues];
}
