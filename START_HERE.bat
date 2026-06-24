@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title CountVoice Local Launcher (no Python)
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_local_proxy.ps1"
set "RC=%ERRORLEVEL%"
echo.
echo ------------------------------------------------------------
echo Launcher finished. Exit code: %RC%
echo Press any key to close this window.
echo ------------------------------------------------------------
pause >nul
endlocal
