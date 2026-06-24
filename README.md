# CountVoice v10

VOICEVOXで事前生成した `.ponvoice` 音声パックを使って、毎秒カウントするWebアプリです。

## 今回の変更

- 画面の一番上に「URLから音声パックを読み込む」を移動し、初回導線を強化
- 標準音声パックを Service Worker の事前キャッシュ対象に追加
- iPhone向けに `navigator.audioSession.type = "playback"` を使える環境では再生セッションを明示
- 音声パック利用時、開始直後に最大30分先まで Web Audio の音声を予約再生
- `MediaStreamAudioDestinationNode` と `<audio>` を組み合わせ、HTMLメディア再生として扱える場合はそちらを優先
- Media Session API が使える環境では、再生・一時停止操作を連携

## 使い方

1. GitHub PagesなどHTTPSで公開したURLをiPhoneのSafariで開きます。
2. 画面最上部の **「URLから読み込む」** を押します。
3. 「開始」を押し、数秒読み上げられることを確認します。
4. Safariの共有メニューから **「ホーム画面に追加」** を実行します。
5. 追加したアプリから起動し、もう一度「開始」を押してから画面ロックして試します。

標準の音声パックは次の場所です。

```text
packs/poncount__zundamon-normal__standard__1.35__20260624__v01.ponvoice
```

## iPhoneバックグラウンド再生について

この版は、Webで取りうる改善策を入れています。ただし、iOSは電話・他アプリの音声・省電力・Safari/PWAの実装差でWebアプリの実行や音声を中断する場合があります。**Webアプリとして無制限・完全保証のバックグラウンド読み上げはできません。**

特に長時間使う場合は、まず5〜10分で動作を確認してください。より確実な無制限バックグラウンド再生が必要な場合は、ネイティブiOSアプリ化が必要です。

## ローカルで起動する

PowerShellでこのフォルダを開き、次を実行します。

```powershell
.\start-server.ps1
```

その後、ブラウザで `http://127.0.0.1:8765/index.html` を開きます。

## VOICEVOXで音声を作る

1. PCでVOICEVOX Engineを起動します。
2. `voice-pack-maker.html` を開きます。
3. `http://127.0.0.1:50021` に接続します。
4. 話者、パック、読み上げ速度を選びます。
5. 「作成して保存」で `.ponvoice` を保存します。

## 注意

VOICEVOX音声を使う場合は、VOICEVOX本体と各音声ライブラリの利用規約を確認してください。公開や配布をする場合、必要なクレジット表記を入れてください。
