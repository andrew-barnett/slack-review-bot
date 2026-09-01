#!/usr/bin/env bash
#
# Install and load the slack-review-bot LaunchAgent.
#
# Usage:
#   scripts/install-service.sh            # render, load, and start
#   scripts/install-service.sh --uninstall
#
# Expects a credentials file at ~/.config/slack-review-bot/env (override with
# SLACK_REVIEW_BOT_ENV) containing at least:
#
#   SLACK_BOT_TOKEN=xoxb-...
#   SLACK_APP_TOKEN=xapp-...
#   SLACK_CHANNEL_IDS=C0123456789
#
# That file is sourced by the agent at launch and must be mode 0600 — this script
# refuses to install otherwise. Credentials are deliberately kept out of the plist,
# which is world-readable.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." > /dev/null 2>&1 && pwd)"
LABEL="com.abarnett.slack-review-bot"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
ENV_FILE="${SLACK_REVIEW_BOT_ENV:-${HOME}/.config/slack-review-bot/env}"
LOG_DIR="${HOME}/Library/Logs"
APP="${DIR}/dist/app.js"

if [ "${1:-}" = "--uninstall" ]; then
    launchctl bootout "gui/$(id -u)/${LABEL}" 2> /dev/null || true
    rm -f "${PLIST}"
    echo "uninstalled ${LABEL}"
    exit 0
fi

##
## Preflight. Each of these fails in a way that is invisible from Slack — the bot simply
## never reacts — so they are checked here rather than at runtime.
##

if [ ! -f "${APP}" ]; then
    echo "ERROR: ${APP} not found. Run 'npm install && npm run build' first." >&2
    exit 1
fi

if [ ! -f "${ENV_FILE}" ]; then
    echo "ERROR: credentials file ${ENV_FILE} not found." >&2
    echo "       Create it with SLACK_BOT_TOKEN, SLACK_APP_TOKEN and SLACK_CHANNEL_IDS," >&2
    echo "       then: chmod 600 ${ENV_FILE}" >&2
    exit 1
fi

PERMS="$(stat -f '%Lp' "${ENV_FILE}")"
if [ "${PERMS}" != "600" ]; then
    echo "ERROR: ${ENV_FILE} is mode ${PERMS}; it holds Slack tokens and must be 600." >&2
    echo "       Fix with: chmod 600 ${ENV_FILE}" >&2
    exit 1
fi

if ! "${DIR}/scripts/install-codex-profile.sh" --check; then
    echo "ERROR: the Codex profile is not installed. Run scripts/install-codex-profile.sh" >&2
    exit 1
fi

NODE="$(command -v node)"
if [ -z "${NODE}" ]; then
    echo "ERROR: node not found on PATH" >&2
    exit 1
fi

# The agent's PATH has to be built here, not left to the shell in the plist. launchd
# hands the job a bare PATH and `zsh -lc` never reads ~/.zshrc, so the Homebrew and nvm
# entries this script sees are absent at runtime. Resolving them now and baking them
# into the plist is what keeps `codex`, `gh`, `git`, `npm` and `pnpm` reachable.
HOMEBREW_PREFIX="$(brew --prefix 2> /dev/null || true)"
if [ -z "${HOMEBREW_PREFIX}" ]; then
    echo "ERROR: brew not found on PATH; cannot determine where codex and gh live" >&2
    exit 1
fi
# The node bin dir leads, matching the interactive precedence ~/.zshrc produces (nvm
# prepends after `brew shellenv`). Otherwise `npm` would resolve to a Homebrew npm bound
# to a different node than the one running the agent.
PATH_PREFIX="$(dirname "${NODE}"):${HOMEBREW_PREFIX}/bin:${HOMEBREW_PREFIX}/sbin"

# Prove the prefix is sufficient under launchd's environment rather than this one.
# Without this the breakage is invisible until the first review runs: the bot starts
# fine (node is invoked by absolute path) and only the Codex spawn fails, minutes or
# days later, with `spawn codex ENOENT`.
for tool in codex gh git; do
    if ! PATH="${PATH_PREFIX}:/usr/bin:/bin:/usr/sbin:/sbin" command -v "${tool}" > /dev/null 2>&1; then
        echo "ERROR: ${tool} does not resolve under the agent's PATH (${PATH_PREFIX})" >&2
        echo "       The agent would fail at run time with: spawn ${tool} ENOENT" >&2
        exit 1
    fi
done

mkdir -p "${HOME}/Library/LaunchAgents" "${LOG_DIR}"

sed -e "s|__LABEL__|${LABEL}|g" \
    -e "s|__NODE__|${NODE}|g" \
    -e "s|__APP__|${APP}|g" \
    -e "s|__DIR__|${DIR}|g" \
    -e "s|__LOG_DIR__|${LOG_DIR}|g" \
    -e "s|__ENV_FILE__|${ENV_FILE}|g" \
    -e "s|__PATH_PREFIX__|${PATH_PREFIX}|g" \
    "${DIR}/launchd/${LABEL}.plist.template" > "${PLIST}"

# bootout first so a re-install picks up the new plist rather than leaving the old
# definition loaded; ignore the failure when nothing is loaded yet.
launchctl bootout "gui/$(id -u)/${LABEL}" 2> /dev/null || true
launchctl bootstrap "gui/$(id -u)" "${PLIST}"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

echo "installed and started ${LABEL}"
echo "  plist: ${PLIST}"
echo "  logs:  ${LOG_DIR}/slack-review-bot.out.log"
echo
echo "Tail the log to confirm it connected:"
echo "  tail -f ${LOG_DIR}/slack-review-bot.out.log"
