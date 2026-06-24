# CountVoice

VOICEVOXで事前生成した `.ponvoice` 音声パックを使って、毎秒カウントするWebアプリです。

## GitHub Pagesで使う

このフォルダをGitHubにアップし、GitHub Pagesを有効にすると静的サイトとして動きます。

標準の音声パックは次の場所に置いてあります。

```text
packs/poncount__zundamon-normal__standard__1.35__20260624__v01.ponvoice
```

メイン画面の「URLから読込」を押すと、この音声パックをWebから読み込みます。

URLパラメータでも自動読み込みできます。

```text
index.html?pack=./packs/poncount__zundamon-normal__standard__1.35__20260624__v01.ponvoice
```

## ローカルで起動する

PowerShellでこのフォルダを開き、次を実行します。

```powershell
.\start-server.ps1
```

その後、ブラウザで `http://127.0.0.1:8765/index.html` を開きます。

## 読み上げルール

- `1〜9` は数字だけ
- `10 / 20 / 30 / 40 / 50` は `10秒` のように秒付き
- 分ぴったりは `1分` から `59分`
- 1時間ぴったりは `1時間`

## VOICEVOXで音声を作る

1. PCでVOICEVOX Engineを起動します。
2. `voice-pack-maker.html` を開きます。
3. `http://127.0.0.1:50021` に接続します。
4. 話者、パック、読み上げ速度を選びます。
5. 「作成して保存」で `.ponvoice` を保存します。

## 注意

VOICEVOX音声を使う場合は、VOICEVOX本体と各音声ライブラリの利用規約を確認してください。公開や配布をする場合、必要なクレジット表記を入れてください。
