#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Please install Node.js 24+ from https://nodejs.org'
  exit 1
fi
if ! node -e 'if(!process.allowedNodeEnvironmentFlags.has("--use-env-proxy"))process.exit(1)'; then
  printf '%s\n' 'Please install the latest Node.js 24 LTS, at least 24.5.'
  exit 1
fi
if ! node scripts/check-dependencies.mjs; then
  printf '%s\n' 'Installing DeepSeek Harness. First launch may take a few minutes...'
  npm ci --no-audit --no-fund
fi
exec node --use-env-proxy server.mjs --open
