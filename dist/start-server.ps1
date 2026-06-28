$port = 8765
$python = Get-Command py -ErrorAction SilentlyContinue

if ($python) {
  Write-Host "http://127.0.0.1:$port/index.html を開いてください。"
  & py -3 -m http.server $port
  exit $LASTEXITCODE
}

$python = Get-Command python -ErrorAction SilentlyContinue

if ($python) {
  Write-Host "http://127.0.0.1:$port/index.html を開いてください。"
  & python -m http.server $port
  exit $LASTEXITCODE
}

Write-Host "Pythonが見つかりません。別のHTTPサーバーでこのフォルダを公開してください。"
exit 1
