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

TEMPLATE="${REPO}/claude/review-bot.settings.json.template"
ENV_DIR="$(dirname "${DAEMON_ENV_FILE}")"

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
    sed -e "s|__HOME__|${HOME}|g" \
        -e "s|__PROFILE_DIR__|${PROFILE_DIR}|g" \
        -e "s|__WORKSPACE_ROOT__|${WORKSPACE_ROOT_ARG}|g" \
        -e "s|__WORKTREE_ROOT__|${WORKTREE_ROOT_ARG}|g" \
        -e "s|__ENV_DIR__|${ENV_DIR}|g" \
        -e "s|__GH_CONFIG_DIR__|${GH_DIR}|g" \
        "${TEMPLATE}" > "${PROFILE_DIR}/settings.json"
    echo "installed ${PROFILE_DIR}"
fi

##
## Verify what the engine's safety depends on. Claude Code silently ignores a settings file that
## fails validation, so a broken file would run the engine with no sandbox and no read denies.
## Everything is checked by value, not by grep, by check-claude-profile.js.
##
node "${REPO}/scripts/check-claude-profile.js" "${PROFILE_DIR}" "${ENV_DIR}" "${GH_DIR}"
