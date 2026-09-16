#!/usr/bin/env bash

#
# VENDORED COPY — do not diverge casually.
#
# This is a copy of the platform repos' `login.sh` (e.g. trade-platform/aix-ui:login.sh),
# kept here so the review bot can refresh its AWS CodeArtifact npm token on its own instead
# of inheriting a stale one from a days-old daemon (issue #42). The daemon runs
# `codeartifact-login.sh -u` before each review; the script's own `;expires=` marker makes
# that a no-op until the token actually expires.
#
# It is copied rather than reimplemented so it keeps the exact, tested behavior: a token
# scoped to `@trade-platform` (not the default registry) and self-caching by expiry. The
# CodeArtifact coordinates below (domain, owner, region) are stable infrastructure; if the
# upstream login.sh changes them, re-sync this copy.
#
# --- original header ---
# This script will generate a login token for the private AWS CodeArtifact
# repository.
#
# Only packages in the '@trade-platform' scope will use the repository.
#
# This script requires the following:
#   1. The 'aws' and 'jq' commands installed and in your PATH
#   2. You have a profile called 'staging' already configured
#   3. The access key in the 'staging' profile has access to the AWS
#      CodeArtifact repository.
#
# The scope of the generated configuration can be set from the command-line:
#   -p will store the configuration in the local project.
#   -u, the default, will store the configuration at the user scope.
#   -g will store the configuration at the global scope.
#
# NOTE: If using the local project scope, you MUST have .npmrc in the local
# .gitignore so you're not committing secrets to the repo.
#

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" > /dev/null 2>&1 && pwd)"

##
## Make sure uncommon helper utils are installed
##

DATE="$(command -v gdate)" # prefer gdate over native date
if [ -z "${DATE}" ]; then DATE="$(command -v date)"; fi
if [ -z "${DATE}" ]; then
    echo
    echo "ERROR: You must have some sort of 'date' command installed."
    echo "       If on a Mac, recommend 'brew install coreutils'."
    echo
    exit 1
fi
if [ "$(uname)" = "Darwin" ] && [ "${DATE}" = "/bin/date" ]; then
    echo
    echo "WARNING: The 'date' command on MacOs is non-standard;"
    echo "         Recommend you run 'brew install coreutils'."
    echo
    echo "The following may generate an error..."
    echo
    sleep 1
fi

if [ -z "$(command -v aws)" ]; then
    echo
    echo "ERROR: You must have the 'aws' CLI installed."
    echo "       If on a Mac, recommend 'brew install awscli'."
    echo
    exit 1
fi

if [ -z "$(command -v jq)" ]; then
    echo
    echo "ERROR: You must have the 'jq' util installed."
    echo "       If on a Mac, recommand 'brew install jq'."
    echo
    exit 1
fi

# also need: npm, grep, awk, echo, printf, mv
# ...though those should be part of the standard image

##
## Make sure aws cli has a "staging" profile
##

if ! aws configure list-profiles | grep -qx staging; then
    echo
    echo "ERROR: You must have a 'staging' profile set up for AWS."
    echo "       https://github.com/trade-platform/trade-platform/wiki/Developer-Onboarding#aws"
    echo
    exit 1
fi

##
## Default settings
##

LOCATION="user"
ROOT=""
NPMRC="$(npm config get userconfig)"
VERBOSE=""

##
## Command-line options
##

while getopts ":pughv" opt; do
    case ${opt} in
        p)
            LOCATION="project"
            ROOT="$(npm prefix -L "${LOCATION}")"
            NPMRC="${ROOT}/.npmrc"
            ;;
        u)
            LOCATION="user"
            ROOT=""
            NPMRC="$(npm config get userconfig)"
            ;;
        g)
            LOCATION="global"
            ROOT=""
            NPMRC="$(npm config get globalconfig)"
            ;;
        h)
            echo
            echo "USAGE: $(basename "${0}") [-p] [-u] [-g] [-h] [-v]"
            echo
            echo "-p - write configuration to project npmrc"
            echo "     = $(npm prefix -L project)/.npmrc"
            echo
            echo "-u - write configuration to user npmrc"
            echo "     = $(npm config get userconfig)"
            echo "     *default"
            echo
            echo "-g - write configuration to global npmrc"
            echo "     = $(npm config get globalconfig)"
            echo
            echo "NOTE: The right-most option of the above will supercede previous options."
            echo
            echo "-v - verbose; output some additional information"
            echo
            echo "-h - display this help message and exit"
            echo
            exit 1
            ;;
        v)
            VERBOSE="yes"
            ;;
        *)
            echo
            echo "ERROR: Invalid argument, -${OPTARG}."
            echo "       Try running '$(basename "${0}") -h'"
            echo
            exit 1
            ;;
    esac
done

if [ -n "${VERBOSE}" ]; then
    echo "LOCATION=${LOCATION}"
    echo "ROOT=${ROOT}"
    echo "NPMRC=${NPMRC}"
fi

##
## Configure the registry
##

REGISTRY="$(npm config get -L "${LOCATION}" @trade-platform:registry)"
if [ "${REGISTRY:-undefined}" = "undefined" ]; then
    echo -n "setting repository endpoint"
    # get endpoint
    endpoint="$(aws codeartifact get-repository-endpoint --domain trade-platform --domain-owner 153538148884 --repository trade-platform --format npm --region us-east-2 --profile staging | jq -rc '.repositoryEndpoint')"
    # set a scoped registry
    npm config set -L "${LOCATION}" @trade-platform:registry "${endpoint}"
    echo "...ok"
    if [ -n "${VERBOSE}" ]; then
        echo "REGISTRY=${endpoint}"
    fi
elif [ -n "${VERBOSE}" ]; then
    echo "REGISTRY=${REGISTRY}"
fi

##
## Check the expiration date
##

NOW="$(${DATE} +%s)"
if [ -f "${NPMRC}" ]; then
    EXPIRES="$(grep ';expires=' "${NPMRC}" | awk -F= '{print $2}')"
    if [ -n "${VERBOSE}" ]; then
        echo "EXPIRES=${EXPIRES}"
    fi
else
    EXPIRES=""
fi
if [ -n "${EXPIRES:-}" ]; then
    EXPIRES="$("${DATE}" +%s --date "${EXPIRES}")"
    ## IF THIS LINE ^^^^ FAILS
    # (and you're on a Mac),
    # run 'brew install coreutils'
    # and try again
fi

##
## If missing or expired, update the token
##

if [ "${EXPIRES:-undefined}" = "undefined" ] || [ "${EXPIRES}" -lt "${NOW}" ]; then
    # only check .gitignore for project location
    if [ -d "${ROOT}" ]; then
        # check that .npmrc is in .gitignore before we start saving private tokens in there
        if [ ! -s "${ROOT}/.gitignore" ] || ! grep -q -x '.npmrc' "${ROOT}/.gitignore"; then
            echo
            echo "ERROR: You MUST include '.npmrc' in .gitignore!"
            echo "CHECKED: ${ROOT}/.gitignore"
            echo
            exit 1
        fi
    fi

    echo -n "fetching private repository access token"
    # get token
    tokenJson="$(aws codeartifact get-authorization-token --domain trade-platform --domain-owner 153538148884 --region us-east-2 --profile staging)"
    token="$(jq -rc '.authorizationToken' <<< "${tokenJson}")"
    expiration="$(jq -rc '.expiration' <<< "${tokenJson}")"
    # set token
    npm config set -L "${LOCATION}" "//trade-platform-153538148884.d.codeartifact.us-east-2.amazonaws.com/npm/trade-platform/:_authToken=${token}"
    TMPFILE="$(mktemp)"
    (
        grep -v ';expires=' "${NPMRC}"
        printf ';expires=%s\n' "${expiration}"
    ) > "${TMPFILE}" && mv -f "${TMPFILE}" "${NPMRC}"
    echo "...ok"
fi
