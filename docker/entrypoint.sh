#!/bin/sh
# Container entrypoint: the role is the first argument (spec 3.1).
set -eu

role="${1:-worker}"
if [ "$#" -gt 0 ]; then
    shift
fi

case "${role}" in
    orchestrator) exec node /app/dist/orchestrator.js "$@" ;;
    worker) exec node /app/dist/worker.js "$@" ;;
    doctor) exec node /app/dist/doctor.js "$@" ;;
    *)
        echo "usage: srb-entrypoint orchestrator|worker|doctor [args]" >&2
        exit 2
        ;;
esac
