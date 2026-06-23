# COUNT / VOICE

ブラウザだけで動く、音声読み上げ付きのカウントアプリです。

## 使い方

1. `index.html` をChrome / Edge / Safariなどのブラウザで開きます。
2. 必要なら右上の設定から、声・速度・音量を選びます。
3. 「カウント開始」を押します。

> ブラウザの音声再生制限により、初回は必ずユーザー自身が開始ボタンを押してください。

## 読み上げルール

- 1〜9秒: `1`〜`9`
- 10 / 20 / 30 / 40 / 50秒: `10秒`〜`50秒`
- 分ちょうど: `1分`、`2分`、`10分`…
- 時間ちょうど: `1時間`、`2時間`…
- 例: `1分10秒`では、`10秒`だけを読み上げます。

## ファイル

- `index.html` : 画面構造とアクセシビリティ属性
- `styles.css` : ダークUI、モバイル対応、安全領域、reduced motion対応
- `app.js` : 状態管理、タイマー、SpeechSynthesis、設定保存

## 注意

- 使える日本語音声と自然さは、端末・ブラウザごとに異なります。
- 画面ロック中や別タブ中は、ブラウザがタイマーや音声を抑制する場合があります。
- 復帰後は読み逃した節目をまとめて再生せず、次の節目から再開します。

## 参考

- Web Speech API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API
- SpeechSynthesis: https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis
- `role="timer"`: https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/timer_role
- `prefers-reduced-motion`: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
