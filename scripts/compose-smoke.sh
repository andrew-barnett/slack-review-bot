#!/usr/bin/env bash
#
# Local integration smoke for the container runtime (spec section 6). Builds the image, then runs
# src/smoke.ts: an orchestrator in SMOKE=1 mode and one worker with a stub engine, dummy secrets
# only, in their own Compose project. Not run in CI (it needs Docker).
#
# Usage: scripts/compose-smoke.sh [--no-build]

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." > /dev/null 2>&1 && pwd)"
if [ "${1:-}" != "--no-build" ]; then
    "${REPO}/scripts/build-image.sh"
fi
cd "${REPO}"
exec npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/smoke.ts
