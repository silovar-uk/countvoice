# CountVoice v18 - green clock icons + finish-message pack URL

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

Create this file with `voice-pack-maker.html` and place it in the `packs` folder before deploying to GitHub Pages. It must include the finish message `時間になったのだ`. The older v01 pack is intentionally not renamed because it does not contain that finish-message audio.

## App icons

A green clock icon set based on `icons/icon-source-green-clock.png` is included.

- `favicon.ico`: browser / Windows favicon
- `icons/favicon-16x16.png`, `icons/favicon-32x32.png`, `icons/favicon-48x48.png`, `icons/favicon-64x64.png`: browser variants
- `icons/apple-touch-icon.png`: iPhone home-screen icon
- `icons/icon-192.png`, `icons/icon-512.png`: PWA icons
- `icons/icon-512-maskable.png`: Android maskable PWA icon

After deploying the update, reload once with cache bypass (Windows: `Ctrl + Shift + R`) or remove and re-add the iPhone home-screen shortcut if the old icon remains.
