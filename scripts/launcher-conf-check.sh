# Sourced by scripts/launcher and scripts/install-launcher.sh: the one definition of what a launcher
# settings file may not contain. Secrets come from Secrets Manager only, so a line assigning a
# secret-named variable is refused rather than loaded.

# conf_sets_secret FILE: succeeds (status 0) when FILE assigns a secret-named variable.
conf_sets_secret() {
    grep -qE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_]*(TOKEN|SECRET|LAUNCH_KEY|WORKER_TICKET|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)[A-Za-z_]*=' "$1"
}

# conf_value FILE NAME: print the last plain NAME=value assignment in FILE (no quotes), or nothing.
conf_value() {
    sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$2=([0-9A-Za-z_.:\/-]*)[[:space:]]*$/\2/p" "$1" | tail -n 1
}
