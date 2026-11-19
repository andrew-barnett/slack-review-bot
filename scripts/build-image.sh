#!/usr/bin/env bash
#
# Build the slack-review-bot image from the committed tree (git archive HEAD), with the review-pr
# skill and the secret-blocking hook taken from the aqua-skills commit pinned in
# docker/aqua-skills.ref (ruling 12). No GitHub token is used: the pinned commit must already be in
# the local aqua-skills clone.
#
# Usage: scripts/build-image.sh
#   AQUA_SKILLS_DIR  local aqua-skills clone (default ~/src/aqua-skills)
#   SRB_IMAGE        image tag (default slack-review-bot:local)
#   PLATFORM         buildx platform (default linux/arm64)

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." > /dev/null 2>&1 && pwd)"
AQUA_DIR="${AQUA_SKILLS_DIR:-${HOME}/src/aqua-skills}"
IMAGE="${SRB_IMAGE:-slack-review-bot:local}"
PLATFORM="${PLATFORM:-linux/arm64}"

REF="$(tr -d '[:space:]' < "${REPO}/docker/aqua-skills.ref")"
if ! printf '%s' "${REF}" | grep -qE '^[0-9a-f]{40}$'; then
    echo "ERROR: docker/aqua-skills.ref must hold one 40-character commit SHA" >&2
    exit 1
fi
if ! git -C "${AQUA_DIR}" cat-file -e "${REF}^{commit}" 2> /dev/null; then
    echo "ERROR: ${REF} is not in ${AQUA_DIR}; run: git -C ${AQUA_DIR} fetch origin" >&2
    exit 1
fi

CTX="$(mktemp -d)"
trap 'rm -rf "${CTX}"' EXIT
mkdir -p "${CTX}/app" "${CTX}/aqua"
# Archive to files, not a pipe: bsdtar (macOS) stops reading at the end-of-archive marker, so
# `git archive` dies of SIGPIPE writing its trailing padding and pipefail fails the build (exit 141).
git -C "${REPO}" archive --output "${CTX}/app.tar" HEAD
tar -x -f "${CTX}/app.tar" -C "${CTX}/app"
git -C "${AQUA_DIR}" archive --output "${CTX}/aqua.tar" "${REF}" skills/review-pr security/block-secret-reads.py
tar -x -f "${CTX}/aqua.tar" -C "${CTX}/aqua"
rm -f "${CTX}/app.tar" "${CTX}/aqua.tar"

docker buildx build \
    --platform "${PLATFORM}" \
    --load \
    --tag "${IMAGE}" \
    --build-context "aqua=${CTX}/aqua" \
    "${CTX}/app"
echo "built ${IMAGE} from $(git -C "${REPO}" rev-parse --short HEAD) with aqua-skills ${REF:0:12}"
