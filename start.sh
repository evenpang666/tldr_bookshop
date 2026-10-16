#!/usr/bin/env sh
set -eu
THINBOOK_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$THINBOOK_ROOT"
. "$THINBOOK_ROOT/scripts/bootstrap-node.sh"
thinbook_prepare_node
if [ "$#" -eq 0 ]; then set -- --open; fi
exec "$THINBOOK_NODE" "$THINBOOK_ROOT/scripts/environment.mjs" "$@"
