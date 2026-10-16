#!/usr/bin/env sh
# Sourced by start.sh; keep the runtime and PATH local to this launch.
thinbook_node_ok() {
  "$1" -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<24||(major===24&&minor<5)||!process.allowedNodeEnvironmentFlags.has("--use-env-proxy"))process.exit(1)' >/dev/null 2>&1
}

thinbook_download() {
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --connect-timeout 10 --max-time 120 --retry 1 --output "$2" "$1" ||
      curl --noproxy '*' --fail --location --connect-timeout 10 --max-time 120 --output "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget --timeout=30 --tries=2 -O "$2" "$1" ||
      HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= http_proxy= https_proxy= all_proxy= wget --no-proxy --timeout=30 --tries=1 -O "$2" "$1"
  else
    printf '%s\n' 'Automatic Node.js setup needs curl or wget. Install one and start again.' >&2
    return 1
  fi
}

thinbook_install_node() (
  set -eu
  case "$(uname -s)" in Linux) thinbook_os=linux ;; Darwin) thinbook_os=darwin ;; *) printf '%s\n' 'Unsupported system. Use start.bat on Windows.' >&2; exit 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) thinbook_arch=x64 ;; aarch64|arm64) thinbook_arch=arm64 ;; *) printf '%s\n' 'Automatic Node.js setup supports x64 and arm64.' >&2; exit 1 ;; esac
  command -v tar >/dev/null 2>&1 || { printf '%s\n' 'Automatic Node.js setup needs tar.' >&2; exit 1; }
  mkdir -p "$THINBOOK_ROOT/.runtime/node" || exit 1
  thinbook_stage=$(mktemp -d "$THINBOOK_ROOT/.runtime/node/.install-XXXXXX") || exit 1
  trap 'rm -rf "$thinbook_stage"' EXIT
  trap 'exit 130' INT TERM
  printf '%s\n' 'Preparing Node.js 24 LTS and npm. First launch requires a download...'
  thinbook_download 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' "$thinbook_stage/SHASUMS256.txt" || exit 1
  thinbook_archive=$(awk -v suffix="-$thinbook_os-$thinbook_arch.tar.gz" '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-/ && substr($2,length($2)-length(suffix)+1)==suffix {print $2; exit}' "$thinbook_stage/SHASUMS256.txt")
  [ -n "$thinbook_archive" ] || { printf '%s\n' 'The official Node.js archive was not found for this platform.' >&2; exit 1; }
  thinbook_release=${thinbook_archive#node-}; thinbook_release=${thinbook_release%%-*}
  thinbook_download "https://nodejs.org/dist/$thinbook_release/$thinbook_archive" "$thinbook_stage/$thinbook_archive" || exit 1
  thinbook_expected=$(awk -v name="$thinbook_archive" '$2==name {print $1}' "$thinbook_stage/SHASUMS256.txt")
  if command -v sha256sum >/dev/null 2>&1; then thinbook_actual=$(sha256sum "$thinbook_stage/$thinbook_archive" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then thinbook_actual=$(shasum -a 256 "$thinbook_stage/$thinbook_archive" | awk '{print $1}')
  elif command -v openssl >/dev/null 2>&1; then thinbook_actual=$(openssl dgst -sha256 "$thinbook_stage/$thinbook_archive" | awk '{print $NF}')
  else printf '%s\n' 'No SHA-256 verification tool is available.' >&2; exit 1; fi
  [ "$thinbook_actual" = "$thinbook_expected" ] || { printf '%s\n' 'Node.js download checksum mismatch. Start again to retry.' >&2; exit 1; }
  tar -xzf "$thinbook_stage/$thinbook_archive" -C "$thinbook_stage" || exit 1
  thinbook_unpacked="$thinbook_stage/${thinbook_archive%.tar.gz}"
  thinbook_node_ok "$thinbook_unpacked/bin/node" || { printf '%s\n' 'Downloaded Node.js cannot run on this system.' >&2; exit 1; }
  "$thinbook_unpacked/bin/node" "$thinbook_unpacked/lib/node_modules/npm/bin/npm-cli.js" --version >/dev/null || exit 1
  if [ -e "$THINBOOK_ROOT/.runtime/node/current" ]; then mv "$THINBOOK_ROOT/.runtime/node/current" "$thinbook_stage/previous"; fi
  if ! mv "$thinbook_unpacked" "$THINBOOK_ROOT/.runtime/node/current"; then
    if [ -e "$thinbook_stage/previous" ]; then mv "$thinbook_stage/previous" "$THINBOOK_ROOT/.runtime/node/current"; fi
    exit 1
  fi
)

thinbook_prepare_node() {
  THINBOOK_NODE=$(command -v node || true)
  if [ -n "$THINBOOK_NODE" ] && thinbook_node_ok "$THINBOOK_NODE" && command -v npm >/dev/null 2>&1 && npm --version >/dev/null 2>&1; then
    PATH="$(dirname -- "$THINBOOK_NODE"):$PATH"
  else
    THINBOOK_NODE="$THINBOOK_ROOT/.runtime/node/current/bin/node"
    if ! thinbook_node_ok "$THINBOOK_NODE" || ! "$THINBOOK_NODE" "$THINBOOK_ROOT/.runtime/node/current/lib/node_modules/npm/bin/npm-cli.js" --version >/dev/null 2>&1; then
      thinbook_install_node || return 1
    fi
    PATH="$THINBOOK_ROOT/.runtime/node/current/bin:$PATH"
    npm_execpath="$THINBOOK_ROOT/.runtime/node/current/lib/node_modules/npm/bin/npm-cli.js"
    export npm_execpath
  fi
  THINBOOK_BOOTSTRAPPED=1
  export THINBOOK_NODE PATH THINBOOK_BOOTSTRAPPED
}
