#!/usr/bin/env bash
#
# Install and load the container-runtime launcher LaunchAgent (spec 3.6).
#
# Usage:
#   scripts/install-launcher.sh             # render, load and start
#   scripts/install-launcher.sh --check     # verify prerequisites only
#   scripts/install-launcher.sh --uninstall
#
# Settings come from ~/.config/slack-review-bot/launcher.conf (override with
# SLACK_REVIEW_BOT_LAUNCHER_CONF): non-secret KEY=value lines such as REVIEW_ENGINES, CONCURRENCY,
# SLACK_CHANNEL_IDS, ROLE_GH_LOGIN and OPERATOR_GH_LOGIN. A line naming a secret variable is refused.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." > /dev/null 2>&1 && pwd)"
LABEL="com.abarnett.slack-review-bot-launcher"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
CONF="${SLACK_REVIEW_BOT_LAUNCHER_CONF:-${HOME}/.config/slack-review-bot/launcher.conf}"
LOG_DIR="${HOME}/Library/Logs"
LAUNCHER="${DIR}/scripts/launcher"
MODE="install"

case "${1:-}" in
    --uninstall) MODE="uninstall" ;;
    --check) MODE="check" ;;
    "") ;;
    *)
        echo "unknown argument: $1" >&2
        exit 2
        ;;
esac

if [ "${MODE}" = "uninstall" ]; then
    launchctl bootout "gui/$(id -u)/${LABEL}" 2> /dev/null || true
    rm -f "${PLIST}"
    echo "uninstalled ${LABEL}"
    exit 0
fi

fail=0
if [ ! -f "${DIR}/dist/launcher.js" ]; then
    echo "ERROR: ${DIR}/dist/launcher.js not found. Run 'npm ci && npm run build' first." >&2
    fail=1
fi
# shellcheck source=launcher-conf-check.sh
. "${DIR}/scripts/launcher-conf-check.sh"
if [ -f "${CONF}" ] && conf_sets_secret "${CONF}"; then
    echo "ERROR: ${CONF} sets a secret variable; secrets come from Secrets Manager only." >&2
    fail=1
fi
if [ -f "${HOME}/Library/LaunchAgents/com.abarnett.slack-review-bot.plist" ]; then
    echo "ERROR: the launchd daemon is still installed; run scripts/install-service.sh --uninstall first." >&2
    fail=1
fi
for tool in docker node aws; do
    if ! command -v "${tool}" > /dev/null 2>&1; then
        echo "ERROR: ${tool} is not on PATH" >&2
        fail=1
    fi
done
if [ "${fail}" -ne 0 ]; then
    exit 1
fi

# The PATH launchd will use: the directories holding docker, node and aws, verified below.
PATH_PREFIX="$(dirname "$(command -v docker)"):$(dirname "$(command -v node)"):$(dirname "$(command -v aws)")"
if ! env -i HOME="${HOME}" PATH="${PATH_PREFIX}:/usr/bin:/bin:/usr/sbin:/sbin" /bin/bash -c 'command -v docker && command -v node && command -v aws' > /dev/null; then
    echo "ERROR: docker, node or aws does not resolve under the launchd PATH ${PATH_PREFIX}" >&2
    exit 1
fi

if [ "${MODE}" = "check" ]; then
    echo "launcher prerequisites look correct (conf ${CONF}, PATH ${PATH_PREFIX})"
    exit 0
fi

# launchd SIGKILLs the launcher ExitTimeOut seconds after SIGTERM, so it must cover the launcher's own
# worst case: drain + the 10 s run grace + the 30 s hard bound + 30 s for workers, plus margin.
DRAIN_MS="$([ -f "${CONF}" ] && conf_value "${CONF}" SHUTDOWN_DRAIN_MS || true)"
case "${DRAIN_MS}" in '' | *[!0-9]*) DRAIN_MS=5000 ;; esac
EXIT_TIMEOUT=$(((DRAIN_MS + 10000 + 30000 + 30000 + 999) / 1000 + 75))

mkdir -p "$(dirname "${PLIST}")" "${LOG_DIR}"
sed -e "s|__LABEL__|${LABEL}|g" \
    -e "s|__EXIT_TIMEOUT__|${EXIT_TIMEOUT}|g" \
    -e "s|__LAUNCHER__|${LAUNCHER}|g" \
    -e "s|__DIR__|${DIR}|g" \
    -e "s|__LOG_DIR__|${LOG_DIR}|g" \
    -e "s|__CONF__|${CONF}|g" \
    -e "s|__PATH_PREFIX__|${PATH_PREFIX}|g" \
    "${DIR}/launchd/${LABEL}.plist.template" > "${PLIST}"
launchctl bootout "gui/$(id -u)/${LABEL}" 2> /dev/null || true
launchctl bootstrap "gui/$(id -u)" "${PLIST}"
echo "installed and started ${LABEL}; logs in ${LOG_DIR}/slack-review-bot-launcher.*.log"
