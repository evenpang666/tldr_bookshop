@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS from https://nodejs.org
  pause
  exit /b 1
)
node -e "if(!process.allowedNodeEnvironmentFlags.has('--use-env-proxy'))process.exit(1)"
if errorlevel 1 (
  echo Please install the latest Node.js 24 LTS, at least 24.5.
  pause
  exit /b 1
)
node scripts/check-dependencies.mjs
if errorlevel 1 (
  echo Installing DeepSeek Harness. First launch may take a few minutes...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo Installation failed. Check your network and try again.
    pause
    exit /b 1
  )
)
node --use-env-proxy server.mjs --open
if errorlevel 1 pause
