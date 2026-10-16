@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-node.ps1"
if errorlevel 1 (
  echo Environment setup or startup failed. Check the message above and try again.
  pause
  exit /b 1
)
