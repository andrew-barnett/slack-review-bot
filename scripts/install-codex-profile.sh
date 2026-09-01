#!/usr/bin/env bash
#
# Render codex/review-bot.config.toml.template into $CODEX_HOME and verify it.
#
# The profile is what lets the $review-pr skill run unattended: approvals off, sandbox
# network on, caches writable. It is layered ON TOP of the user's base config by
# `codex exec --profile <name>`, so installing it does not change any interactive run.
#
# Usage: scripts/install-codex-profile.sh [--name review-bot] [--check]

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." > /dev/null 2>&1 && pwd)"
CODEX_HOME="${CODEX_HOME:-${HOME}/.codex}"
NAME="review-bot"
CHECK_ONLY=0

while [ $# -gt 0 ]; do
    case "$1" in
        --name)
            NAME="$2"
            shift 2
            ;;
        --check)
            CHECK_ONLY=1
            shift
            ;;
        -h | --help)
            sed -n '2,9p' "$0"
            exit 0
            ;;
        *)
            echo "unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

TEMPLATE="${DIR}/codex/review-bot.config.toml.template"
TARGET="${CODEX_HOME}/${NAME}.config.toml"

if [ ! -f "${TEMPLATE}" ]; then
    echo "ERROR: template not found at ${TEMPLATE}" >&2
    exit 1
fi

if [ "${CHECK_ONLY}" -eq 0 ]; then
    mkdir -p "${CODEX_HOME}"
    # Codex config.toml has no variable expansion, so absolute paths are baked in here.
    sed "s|__HOME__|${HOME}|g" "${TEMPLATE}" > "${TARGET}"
    echo "installed ${TARGET}"
fi

if [ ! -f "${TARGET}" ]; then
    echo "ERROR: ${TARGET} is not installed. Run without --check to install it." >&2
    exit 1
fi

##
## Verify the two settings the bot actually depends on. Both fail silently in ways that
## are hard to diagnose from Slack: a missing approval override makes runs hang until
## the timeout, and a missing network grant makes every gh/git/npm call fail with a DNS
## error that reads like a network outage.
##

fail=0

if ! grep -qE '^\s*approval_policy\s*=\s*"never"' "${TARGET}"; then
    echo "ERROR: ${TARGET} does not set approval_policy = \"never\"" >&2
    fail=1
fi

if ! grep -qE '^\s*network_access\s*=\s*true' "${TARGET}"; then
    echo "ERROR: ${TARGET} does not set network_access = true" >&2
    fail=1
fi

if grep -q '__HOME__' "${TARGET}"; then
    echo "ERROR: ${TARGET} still contains unsubstituted __HOME__ placeholders" >&2
    fail=1
fi

if [ "${fail}" -ne 0 ]; then
    exit 1
fi

echo "profile '${NAME}' looks correct (approvals off, sandbox network on)"
