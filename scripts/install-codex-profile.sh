#!/usr/bin/env bash
#
# Render codex/review-bot.config.toml.template into $CODEX_HOME and verify it.
#
# The profile is what lets the $review-pr skill run unattended: approvals off, sandbox
# network on, caches writable. It is layered ON TOP of the user's base config by
# `codex exec --profile <name>`, so installing it does not change any interactive run.
#
# Usage: scripts/install-codex-profile.sh [--name review-bot] [--check] [--container [--build]]
#
# --container installs the worker-container profile (danger-full-access, AWS_* excluded from model
# shell commands) and refuses to verify outside a container; --build skips only that probe.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." > /dev/null 2>&1 && pwd)"
CODEX_HOME="${CODEX_HOME:-${HOME}/.codex}"
NAME="review-bot"
CHECK_ONLY=0
CONTAINER=0
BUILD=0

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
        --container)
            CONTAINER=1
            shift
            ;;
        --build)
            BUILD=1
            shift
            ;;
        -h | --help)
            sed -n '2,12p' "$0"
            exit 0
            ;;
        *)
            echo "unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

TEMPLATE="${DIR}/codex/review-bot.config.toml.template"
if [ "${CONTAINER}" -eq 1 ]; then
    TEMPLATE="${DIR}/codex/review-bot.config.container.toml"
fi
TARGET="${CODEX_HOME}/${NAME}.config.toml"

# Same probe as scripts/claude-profile-lib.js; CONTAINER_PROBE_ROOT is a test seam.
in_container() {
    local root="${CONTAINER_PROBE_ROOT:-/}"
    [ -e "${root%/}/.dockerenv" ] || [ -e "${root%/}/run/.containerenv" ] ||
        grep -qE 'docker|containerd|kubepods|libpod' "${root%/}/proc/1/cgroup" 2> /dev/null
}

if [ ! -f "${TEMPLATE}" ]; then
    echo "ERROR: template not found at ${TEMPLATE}" >&2
    exit 1
fi

# Refuse before writing anything: a full-access profile written on the host would replace the
# sandboxed laptop profile of the same name even though the check below then fails.
if [ "${CONTAINER}" -eq 1 ] && [ "${BUILD}" -eq 0 ] && ! in_container; then
    echo "ERROR: the container profile is full access, so it may only be installed inside a container" >&2
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

if [ "${CONTAINER}" -eq 1 ]; then
    if ! grep -qE '^\s*sandbox_mode\s*=\s*"danger-full-access"' "${TARGET}"; then
        echo "ERROR: ${TARGET} does not set sandbox_mode = \"danger-full-access\" (the container is the boundary)" >&2
        fail=1
    fi
    if ! grep -qE '^\s*inherit\s*=\s*"all"' "${TARGET}"; then
        echo "ERROR: ${TARGET} does not set shell_environment_policy.inherit = \"all\"" >&2
        fail=1
    fi
    if ! grep -qE '^\s*exclude\s*=\s*\[\s*"AWS_\*"\s*\]' "${TARGET}"; then
        echo "ERROR: ${TARGET} does not exclude AWS_* from model shell commands" >&2
        fail=1
    fi
    if grep -qE '^\s*writable_roots' "${TARGET}"; then
        echo "ERROR: ${TARGET} sets writable_roots, which has no meaning under full access" >&2
        fail=1
    fi
    if [ "${BUILD}" -eq 0 ] && ! in_container; then
        echo "ERROR: the container profile is full access, so it may only be installed inside a container" >&2
        fail=1
    fi
else
    if ! grep -qE '^\s*network_access\s*=\s*true' "${TARGET}"; then
        echo "ERROR: ${TARGET} does not set network_access = true" >&2
        fail=1
    fi
    # Match the setting, not the template's comment explaining why it is not used.
    if grep -qE '^\s*sandbox_mode\s*=\s*"danger-full-access"' "${TARGET}"; then
        echo "ERROR: ${TARGET} sets danger-full-access; the laptop profile must stay sandboxed" >&2
        fail=1
    fi
fi

if grep -q '__HOME__' "${TARGET}"; then
    echo "ERROR: ${TARGET} still contains unsubstituted __HOME__ placeholders" >&2
    fail=1
fi

if [ "${fail}" -ne 0 ]; then
    exit 1
fi

if [ "${CONTAINER}" -eq 1 ]; then
    echo "profile '${NAME}' looks correct (container: approvals off, full access inside the container, AWS_* excluded)"
else
    echo "profile '${NAME}' looks correct (approvals off, sandbox network on)"
fi
