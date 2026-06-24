$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$HostAddress = "127.0.0.1"
$Port = 8786
$EngineUrl = "http://127.0.0.1:50021"
$RootPath = ([System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)) + [System.IO.Path]::DirectorySeparatorChar

function Write-Banner {
  Write-Host "============================================================" -ForegroundColor Cyan
  Write-Host "CountVoice local launcher - PowerShell edition" -ForegroundColor Cyan
  Write-Host "No Python is required for this launcher." -ForegroundColor Green
  Write-Host "============================================================" -ForegroundColor Cyan
}

function Get-VoicevoxStatus {
  try {
    $request = [System.Net.HttpWebRequest]::Create("$EngineUrl/speakers")
    $request.Method = "GET"
    $request.Timeout = 8000
    $request.ReadWriteTimeout = 8000
    $response = [System.Net.HttpWebResponse]$request.GetResponse()
    try {
      if ([int]$response.StatusCode -ne 200) {
        return @{ Ok = $false; Detail = "HTTP $([int]$response.StatusCode)" }
      }
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [System.Text.Encoding]::UTF8)
      try {
        $body = $reader.ReadToEnd()
      } finally {
        $reader.Dispose()
      }
      $speakers = $body | ConvertFrom-Json
      $count = @($speakers).Count
      if ($count -lt 1) {
        return @{ Ok = $false; Detail = "No speakers were returned" }
      }
      return @{ Ok = $true; Detail = "$count speaker groups" }
    } finally {
      $response.Close()
    }
  } catch {
    return @{ Ok = $false; Detail = $_.Exception.Message }
  }
}

function Send-Text($context, [int]$statusCode, [string]$text, [string]$contentType = "text/plain; charset=utf-8") {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  $context.Response.StatusCode = $statusCode
  $context.Response.ContentType = $contentType
  $context.Response.ContentEncoding = [System.Text.Encoding]::UTF8
  $context.Response.ContentLength64 = $bytes.Length
  $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $context.Response.Close()
}

function Get-ContentType([string]$path) {
  switch ([System.IO.Path]::GetExtension($path).ToLowerInvariant()) {
    ".html" { return "text/html; charset=utf-8" }
    ".js" { return "text/javascript; charset=utf-8" }
    ".css" { return "text/css; charset=utf-8" }
    ".json" { return "application/json; charset=utf-8" }
    ".webmanifest" { return "application/manifest+json; charset=utf-8" }
    ".svg" { return "image/svg+xml" }
    ".png" { return "image/png" }
    ".jpg" { return "image/jpeg" }
    ".jpeg" { return "image/jpeg" }
    ".wav" { return "audio/wav" }
    ".ponvoice" { return "application/json; charset=utf-8" }
    default { return "application/octet-stream" }
  }
}

function Handle-Static($context) {
  $rawPath = [System.Uri]::UnescapeDataString($context.Request.Url.AbsolutePath)
  $relative = $rawPath.TrimStart('/')
  if ([string]::IsNullOrWhiteSpace($relative)) { $relative = "index.html" }
  $relative = $relative.Replace('/', '\\')
  $filePath = [System.IO.Path]::GetFullPath((Join-Path $RootPath $relative))

  if (-not $filePath.StartsWith($RootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    Send-Text $context 403 "Forbidden"
    return
  }
  if (-not [System.IO.File]::Exists($filePath)) {
    Send-Text $context 404 "Not found"
    return
  }

  $file = New-Object System.IO.FileInfo($filePath)
  $context.Response.StatusCode = 200
  $context.Response.ContentType = Get-ContentType $filePath
  $context.Response.ContentLength64 = $file.Length
  $context.Response.Headers.Add("Cache-Control", "no-store")
  $input = [System.IO.File]::OpenRead($filePath)
  try {
    $input.CopyTo($context.Response.OutputStream)
  } finally {
    $input.Dispose()
    $context.Response.Close()
  }
}

function Handle-Proxy($context) {
  if ($context.Request.HttpMethod -eq "OPTIONS") {
    $context.Response.StatusCode = 204
    $context.Response.Headers.Add("Access-Control-Allow-Origin", "*")
    $context.Response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    $context.Response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
    $context.Response.Close()
    return
  }

  $raw = $context.Request.RawUrl
  $suffix = $raw.Substring("/voicevox".Length)
  if ([string]::IsNullOrWhiteSpace($suffix)) { $suffix = "/" }
  $targetUrl = "$EngineUrl$suffix"
  $upstream = [System.Net.HttpWebRequest]::Create($targetUrl)
  $upstream.Method = $context.Request.HttpMethod
  $upstream.Timeout = 60000
  $upstream.ReadWriteTimeout = 60000
  $upstream.AllowAutoRedirect = $false
  if ($context.Request.ContentType) { $upstream.ContentType = $context.Request.ContentType }
  if ($context.Request.Headers["Accept"]) { $upstream.Accept = $context.Request.Headers["Accept"] }

  try {
    if ($context.Request.HasEntityBody) {
      $upstream.ContentLength = $context.Request.ContentLength64
      $targetStream = $upstream.GetRequestStream()
      try {
        $context.Request.InputStream.CopyTo($targetStream)
      } finally {
        $targetStream.Dispose()
      }
    }

    $upstreamResponse = $null
    try {
      $upstreamResponse = [System.Net.HttpWebResponse]$upstream.GetResponse()
    } catch [System.Net.WebException] {
      if ($_.Exception.Response) {
        $upstreamResponse = [System.Net.HttpWebResponse]$_.Exception.Response
      } else {
        throw
      }
    }

    try {
      $context.Response.StatusCode = [int]$upstreamResponse.StatusCode
      $context.Response.ContentType = if ($upstreamResponse.ContentType) { $upstreamResponse.ContentType } else { "application/octet-stream" }
      $context.Response.Headers.Add("Cache-Control", "no-store")
      $context.Response.Headers.Add("Access-Control-Allow-Origin", "*")
      if ($upstreamResponse.ContentLength -ge 0) { $context.Response.ContentLength64 = $upstreamResponse.ContentLength }
      $sourceStream = $upstreamResponse.GetResponseStream()
      try {
        $sourceStream.CopyTo($context.Response.OutputStream)
      } finally {
        $sourceStream.Dispose()
      }
    } finally {
      $upstreamResponse.Close()
    }
  } catch {
    Send-Text $context 502 ("VOICEVOX proxy error: " + $_.Exception.Message) "text/plain; charset=utf-8"
    return
  } finally {
    if ($context.Response.OutputStream.CanWrite) {
      $context.Response.Close()
    }
  }
}

Write-Banner
$status = Get-VoicevoxStatus
if (-not $status.Ok) {
  Write-Host "" 
  Write-Host "VOICEVOX API CHECK: FAIL" -ForegroundColor Red
  Write-Host "Could not reach: $EngineUrl/speakers" -ForegroundColor Red
  Write-Host "Details: $($status.Detail)" -ForegroundColor Yellow
  Write-Host "" 
  Write-Host "Open this in your browser to test the engine:" -ForegroundColor Cyan
  Write-Host "$EngineUrl/docs" -ForegroundColor White
  Write-Host "" 
  Write-Host "Keep VOICEVOX open, then run START_HERE.bat again." -ForegroundColor Yellow
  exit 1
}

Write-Host "VOICEVOX API CHECK: OK ($($status.Detail))" -ForegroundColor Green

$listener = New-Object System.Net.HttpListener
$prefix = "http://${HostAddress}:$Port/"
$listener.Prefixes.Add($prefix)
try {
  $listener.Start()
} catch {
  Write-Host "" 
  Write-Host "LOCAL SERVER: FAIL" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Yellow
  Write-Host "Close any older CountVoice launcher and try again." -ForegroundColor Yellow
  exit 2
}

$url = "${prefix}voice-pack-maker.html?diagnose=1"
Write-Host "LOCAL SERVER: OK" -ForegroundColor Green
Write-Host "Browser URL: $url" -ForegroundColor White
Write-Host "" 
Write-Host "Leave this window open while you use VOICEVOX." -ForegroundColor Yellow
Start-Process $url

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $path = $context.Request.Url.AbsolutePath
    Write-Host ("[" + $context.Request.HttpMethod + "] " + $path) -ForegroundColor DarkGray
    if ($path -eq "/voicevox" -or $path.StartsWith("/voicevox/")) {
      Handle-Proxy $context
    } else {
      Handle-Static $context
    }
  }
} catch {
  Write-Host "Server stopped: $($_.Exception.Message)" -ForegroundColor Yellow
} finally {
  if ($listener) {
    $listener.Stop()
    $listener.Close()
  }
}
