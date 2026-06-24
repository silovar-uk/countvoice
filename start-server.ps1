$python = "C:\Users\vediv\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
  Write-Host "Pythonが見つかりません。別のHTTPサーバーでこのフォルダを公開してください。"
  exit 1
}

Write-Host "http://127.0.0.1:8765/index.html を開いてください。"
& $python -m http.server 8765
