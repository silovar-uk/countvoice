$ErrorActionPreference = "Stop"
$EngineUrl = "http://127.0.0.1:50021"
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "VOICEVOX API TEST - no Python required" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
try {
  $request = [System.Net.HttpWebRequest]::Create("$EngineUrl/speakers")
  $request.Method = "GET"
  $request.Timeout = 8000
  $response = [System.Net.HttpWebResponse]$request.GetResponse()
  try {
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [System.Text.Encoding]::UTF8)
    try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
    $speakers = $body | ConvertFrom-Json
    $count = @($speakers).Count
    Write-Host "RESULT: OK" -ForegroundColor Green
    Write-Host "Endpoint: $EngineUrl/speakers" -ForegroundColor White
    Write-Host "Speaker groups: $count" -ForegroundColor White
    exit 0
  } finally { $response.Close() }
} catch {
  Write-Host "RESULT: FAIL" -ForegroundColor Red
  Write-Host "Endpoint: $EngineUrl/speakers" -ForegroundColor White
  Write-Host "Details: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "Try opening: $EngineUrl/docs" -ForegroundColor Cyan
  exit 1
}
