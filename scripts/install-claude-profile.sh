#!/usr/bin/env bash
#
# Create the dedicated Claude Code config dir the review engine runs with (CLAUDE_CONFIG_DIR),
# and verify it. The counterpart of install-codex-profile.sh (spec 5.5).
#
# The dir holds only: settings.json (sandbox, read denies, never-prompt permissions, the
# secret-blocking hook), the review-pr skill, and that hook. None of the operator's personal
# hooks, memory, CLAUDE.md, plugins or MCP servers: an unattended run must not inherit them.
#
# Usage: scripts/install-claude-profile.sh [--dir DIR] [--workspace-root DIR] [--worktree-root DIR]
#          [--skill-src DIR] [--hook-src FILE] [--env-file FILE] [--gh-config-dir DIR] [--check]
#          [--container [--npmrc FILE] [--build]]
#
# --container renders the worker-container profile (sandbox off, every deny rule kept) and refuses
# to verify outside a container; --build skips only that probe, for `docker build` steps.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." > /dev/null 2>&1 && pwd)"
PROFILE_DIR="${CLAUDE_CONFIG_DIR_REVIEW:-${HOME}/.claude-review-bot}"
WORKSPACE_ROOT_ARG="${WORKSPACE_ROOT:-${HOME}/src}"
WORKTREE_ROOT_ARG="${WORKTREE_ROOT:-/private/tmp/codex-pr-review}"
SKILL_SRC="${HOME}/.claude/skills/review-pr"
HOOK_SRC="${HOME}/.claude/hooks/block-secret-reads.py"
DAEMON_ENV_FILE="${SLACK_REVIEW_BOT_ENV:-${HOME}/.config/slack-review-bot/env}"
GH_DIR="${GH_CONFIG_DIR:-${HOME}/.config/gh}"
CHECK_ONLY=0
CONTAINER=0
BUILD=0
NPMRC_FILE="${HOME}/.npmrc-worker"

while [ $# -gt 0 ]; do
    case "$1" in
        --dir)
            PROFILE_DIR="$2"
            shift 2
            ;;
        --workspace-root)
            WORKSPACE_ROOT_ARG="$2"
            shift 2
            ;;
        --worktree-root)
            WORKTREE_ROOT_ARG="$2"
            shift 2
            ;;
        --skill-src)
            SKILL_SRC="$2"
            shift 2
            ;;
        --hook-src)
            HOOK_SRC="$2"
            shift 2
            ;;
        --env-file)
            DAEMON_ENV_FILE="$2"
            shift 2
            ;;
        --gh-config-dir)
            GH_DIR="$2"
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
        --npmrc)
            NPMRC_FILE="$2"
            shift 2
            ;;
        -h | --help)
            sed -n '2,16p' "$0"
            exit 0
            ;;
        *)
            echo "unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

# Every directory must be absolute, non-empty, free of ".." segments and not "/": these paths become
# sandbox grants and deny rules, and a relative or root path would silently widen or void them.
# Prints the path without trailing slashes.
require_abs_dir() {
    local name="$1" value="$2"
    if [ -z "${value}" ]; then
        echo "ERROR: ${name} is empty" >&2
        exit 1
    fi
    case "${value}" in
        /*) ;;
        *)
            echo "ERROR: ${name} must be an absolute path: ${value}" >&2
            exit 1
            ;;
    esac
    case "/${value}/" in
        */../*)
            echo "ERROR: ${name} must not contain '..': ${value}" >&2
            exit 1
            ;;
    esac
    while [ "${#value}" -gt 1 ] && [ "${value%/}" != "${value}" ]; do
        value="${value%/}"
    done
    if [ "${value}" = "/" ]; then
        echo "ERROR: ${name} must not be the filesystem root" >&2
        exit 1
    fi
    printf '%s' "${value}"
}

HOME="$(require_abs_dir HOME "${HOME:-}")"
PROFILE_DIR="$(require_abs_dir --dir "${PROFILE_DIR}")"
WORKSPACE_ROOT_ARG="$(require_abs_dir --workspace-root "${WORKSPACE_ROOT_ARG}")"
WORKTREE_ROOT_ARG="$(require_abs_dir --worktree-root "${WORKTREE_ROOT_ARG}")"
SKILL_SRC="$(require_abs_dir --skill-src "${SKILL_SRC}")"
HOOK_SRC="$(require_abs_dir --hook-src "${HOOK_SRC}")"
DAEMON_ENV_FILE="$(require_abs_dir --env-file "${DAEMON_ENV_FILE}")"
GH_DIR="$(require_abs_dir --gh-config-dir "${GH_DIR}")"
ENV_DIR="$(require_abs_dir "--env-file's directory" "$(dirname "${DAEMON_ENV_FILE}")")"
# Mode flags for the renderer and the checker. The `${A[@]+...}` form keeps an empty array safe
# under `set -u` on macOS's bash 3.2.
MODE_ARGS=()
if [ "${CONTAINER}" -eq 1 ]; then
    NPMRC_FILE="$(require_abs_dir --npmrc "${NPMRC_FILE}")"
    MODE_ARGS+=(--container --npmrc "${NPMRC_FILE}")
fi
CHECK_ARGS=(${MODE_ARGS[@]+"${MODE_ARGS[@]}"})
if [ "${BUILD}" -eq 1 ]; then
    CHECK_ARGS+=(--build)
fi

if [ "${CHECK_ONLY}" -eq 0 ]; then
    if [ ! -f "${SKILL_SRC}/SKILL.md" ]; then
        echo "ERROR: no review-pr skill at ${SKILL_SRC} (pass --skill-src)" >&2
        exit 1
    fi
    if [ ! -f "${HOOK_SRC}" ]; then
        echo "ERROR: no secret-blocking hook at ${HOOK_SRC} (pass --hook-src)" >&2
        exit 1
    fi
    mkdir -p "${PROFILE_DIR}/skills" "${PROFILE_DIR}/hooks"
    chmod 700 "${PROFILE_DIR}"
    # Link to the real locations, so the profile follows aqua-skills updates like the operator's own.
    ln -sfn "$(cd "${SKILL_SRC}" && pwd -P)" "${PROFILE_DIR}/skills/review-pr"
    ln -sfn "$(node -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' "${HOOK_SRC}")" \
        "${PROFILE_DIR}/hooks/block-secret-reads.py"
    # Render with node (real JSON, deny dirs resolved with realpath), not sed substitution.
    SETTINGS_JSON="$(node "${REPO}/scripts/claude-profile-lib.js" render ${MODE_ARGS[@]+"${MODE_ARGS[@]}"} "${PROFILE_DIR}" \
        "${WORKSPACE_ROOT_ARG}" "${WORKTREE_ROOT_ARG}" "${ENV_DIR}" "${GH_DIR}" "${HOME}")"
    printf '%s\n' "${SETTINGS_JSON}" > "${PROFILE_DIR}/settings.json"
    echo "installed ${PROFILE_DIR}"
fi

##
## Verify what the engine's safety depends on. Claude Code silently ignores a settings file that
## fails validation, so a broken file would run the engine with no sandbox and no read denies.
## Everything is checked by value, not by grep, by check-claude-profile.js.
##
node "${REPO}/scripts/check-claude-profile.js" ${CHECK_ARGS[@]+"${CHECK_ARGS[@]}"} "${PROFILE_DIR}" "${WORKSPACE_ROOT_ARG}" \
    "${WORKTREE_ROOT_ARG}" "${ENV_DIR}" "${GH_DIR}" "${HOME}"
