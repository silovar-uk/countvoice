# CountVoice v33 - iPhone ambient-noise volume fix

This version fixes the `Forbidden` page caused by a path check in the v15 local launcher. It also does not require Python.

This version does **not** use Python. It uses the Windows built-in PowerShell HTTP server/proxy.

## How to start

1. Extract the ZIP fully.
2. Start VOICEVOX and wait until its main window finishes loading.
3. Double-click `START_HERE.bat`.
4. Keep the black window open.
5. A browser opens this local page:

```text
http://127.0.0.1:8786/voice-pack-maker.html?diagnose=1
```

6. Confirm that the on-page diagnostic says success, then press `接続`.

## If it fails

Double-click `TEST_VOICEVOX.bat`.

- `RESULT: OK` means VOICEVOX itself is ready. Then run `START_HERE.bat` again.
- `RESULT: FAIL` means Windows cannot reach the VOICEVOX Engine. Open this in the same PC browser:

```text
http://127.0.0.1:50021/docs
```

Do not use the public GitHub Pages URL or your iPhone to create a VOICEVOX pack. The voice-pack maker must run in the local PC page opened by `START_HERE.bat`.

## Why this works

The local PowerShell server serves the page at `127.0.0.1:8786` and proxies `/voicevox/...` requests to `127.0.0.1:50021`. This avoids normal browser CORS trouble without requiring Python.

## Finish message

When creating a `.ponvoice`, use the finish message `時間になったのだ` or replace it with your own phrase. The created pack contains that audio clip.

## v16 fix

If v15 opened a browser page showing `Forbidden`, the local server itself was running but its static-file path check was too strict. v16 corrects that path handling.



## Default audio-pack URL

The top "URLから音声パックを読み込む" field now defaults to:

```text
./packs/poncount__zundamon-normal__standard__1.35__end-message__v02.ponvoice
```

The completed audio pack is already included in `packs/`. It contains the finish message `時間になったのだ`, so the top "URLから音声パックを読み込む" button can be used immediately after deployment.

## App icons

A green clock icon set based on `icons/icon-source-green-clock.png` is included.

- `favicon.ico`: browser / Windows favicon
- `icons/favicon-16x16.png`, `icons/favicon-32x32.png`, `icons/favicon-48x48.png`, `icons/favicon-64x64.png`: browser variants
- `icons/apple-touch-icon.png`: iPhone home-screen icon
- `icons/icon-192.png`, `icons/icon-512.png`: PWA icons
- `icons/icon-512-maskable.png`: Android maskable PWA icon

After deploying the update, reload once with cache bypass (Windows: `Ctrl + Shift + R`) or remove and re-add the iPhone home-screen shortcut if the old icon remains.

## Included final audio pack

- File: `packs/poncount__zundamon-normal__standard__1.35__end-message__v02.ponvoice`
- Finish message: `時間になったのだ`
- Credit: `VOICEVOX: ずんだもん`
- The Service Worker pre-caches this pack for offline fallback after the first successful install.

## v20：ずんだグリーンUI

- ライトグリーンを基調に、丸いカード・葉っぱ風の装飾・やわらかいボタンへ刷新しました。
- 上部の「URLから読み込む」を最優先の導線として強調しています。
- 停止中／カウント中／一時停止中／終了時で、表示と短い案内文が変わります。
- 詳細な音声パック・VOICEVOX設定は、メイン画面下部の「詳細設定」にまとめています。

## v22
- 初期の終了時間を900秒（15分）へ変更
- 秒数設定を開始ボタンのすぐ上へ移動

## v22: 他の音声再生後の復帰

- iPhone Safariなどで、他アプリ・他タブの再生によって `AudioContext` が `interrupted` になった場合を検知します。
- 再開時はAudioContextとバックグラウンド用メディア出力をユーザー操作で復帰し、古い予約音声を破棄して現在の秒数から予約し直します。
- 復帰が必要なときだけ、開始ボタンの近くに「音を復帰」を表示します。



## v23: 集中画面モード

- カウント開始後は、タイマーの画面だけがビューポート全体を使う集中画面モードになります。
- 上部の読み込み・設定・詳細パネルはカウント中のみ一時的に隠れ、数字・進行状況・一時停止／リセットへ集中できます。
- 一時停止中・終了表示中も同じ画面に留まり、再開またはリセットで操作できます。
- ブラウザ本体の全画面表示を強制するのではなく、iPhoneを含む各ブラウザで安定するアプリ内の没入表示です。


## v24 変更点

- カウント表示を `HH:MM:SS` 固定表示へ変更しました。
- 数字の表示幅を8文字分で固定し、カウントアップ時も視覚的に中央へ安定するようにしました。


## v25: 終了メッセージの確実な2回読み上げ

- 通常終了では、終了メッセージの予約再生に処理を任せきりにせず、終了した瞬間に専用の再生シーケンスを組み直します。
- `時間になったのだ` などの終了メッセージを、短い間隔を空けて**2回**読み上げます。
- 他の再生に割り込まれたあと、終了済み画面で「音を復帰」を押した場合も、終了メッセージを2回読み上げ直します。
- バックグラウンド時は、開始中に予約した2回分の終了音声を利用します。

- 「終了時に読む言葉」の試聴ボタンも、終了時と同じく終了メッセージを2回読み上げます。


## v26: アプリ音量コントロール

- メイン画面に **アプリの音量** スライダーを追加しました。PC・スマホともに、0〜100%の範囲で即時に調整できます。
- カウント開始後の集中画面にも同じスライダーを残すため、再生中でもすぐに調整できます。
- 音声パック／VOICEVOXローカル音声はWeb Audioのマスターゲインへ、ブラウザ音声はSpeechSynthesisの音量へ反映します。
- 最後に設定した音量は端末のブラウザ内に保存され、次回起動時にも復元されます。
- これはアプリ内の読み上げ音量です。iPhone・PC本体の音量、消音スイッチ、Bluetooth機器の音量は別途影響します。


## v27: 初期音量を50%へ変更

- 新規利用時のアプリ内音量は **50%** で開始します。
- すでに手動で変更した音量は端末内に保存されているため、その設定を優先します。


## v28: モバイル再開時の音声再初期化

- 「開始」「再開」「音を復帰」を押したとき、以前のWeb Audio出力を使い回さず、新しいAudioContextと出力先を作り直します。
- 一時停止後、アプリを閉じた後、ほかの音声に割り込まれた後でも、ユーザー操作をきっかけに音声パックを再デコードし、現在位置から読み上げを予約し直します。
- バックグラウンド優先モードでは、MediaStreamの出力先も再生成してから再生します。
- 終了済み画面で「音を復帰」を押した場合も、終了メッセージを2回読み上げます。


## v29: ながし音（ホワイトノイズ／ブラウンノイズ）

- 「ながし音」で **なし／ホワイトノイズ／ブラウンノイズ** を選べます。初期値は「なし」です。
- 選択したながし音は、**カウント中だけ**読み上げの後ろで流れます。一時停止・リセット・終了時には止まります。
- ながし音の音量は読み上げ音量とは別に0〜100%で調整でき、端末ごとに保存されます。初期値は18%です。
- iPhoneで音声出力を作り直す場合も、再開後に選択中のながし音を再生成します。


## v31: iPhoneのながし音・小画面対応
- ながし音が「なし」の状態でも、音量を事前に調整可能（iOS Safariで選択後も半透明・無効のまま残る問題を回避）。
- iPhone SEなど小さな縦画面では、集中画面が自動的にコンパクト表示へ切り替わります。
- 集中画面はアプリ内パネルだけをスクロールするため、ページ全体が画面外へ押し出されにくくなりました。


## v32: 読み込み済み時のコンパクト導線

- 音声パックを読み込み済みの場合、上部は小さな「読込済み」バーへ切り替わります。
- 同じバーから現在のURLを再読み込みでき、必要なときだけ「URLを変更」で入力欄を展開できます。
- 開始前は「秒数 → 開始」を先に置き、音量・ながし音は折りたたみ式にしました。
- 集中画面はPC・スマホとも、通常状態では画面内で完結するグリッドへ調整しています。


## v33: iPhone ながし音音量の修正

- 未設定のながし音音量が誤って `0%` と扱われる不具合を修正しました。
- 初回・旧版からの更新時は、明示的に0%を選んだ記録がない限り18%へ復元します。
- ホワイト／ブラウンノイズ選択後、つまみが動かない場合でも `− / ＋` ボタンで5%ずつ変更できます。
