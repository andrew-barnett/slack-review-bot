# syntax=docker/dockerfile:1.7
#
# One image, two roles (spec 3.1): `srb-entrypoint orchestrator` and `srb-entrypoint worker`.
# Build with scripts/build-image.sh, which supplies the `aqua` build context (ruling 12).

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
# Public dependencies only (@slack/*), so no registry credential is needed at build time. The lockfile
# resolves every package through the CodeArtifact mirror, and npm only rewrites npmjs hosts for
# --registry, so point the resolved URLs at the public registry first (same tarballs, same integrity).
RUN sed -i 's#https://trade-platform-153538148884.d.codeartifact.us-east-2.amazonaws.com/npm/trade-platform/#https://registry.npmjs.org/#g' package-lock.json \
 && ! grep -q 'codeartifact' package-lock.json \
 && npm ci --ignore-scripts --registry=https://registry.npmjs.org/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ARG TARGETARCH
ARG GH_VERSION=2.103.3
ARG AWSCLI_VERSION=2.40.4
ARG CODEX_VERSION=0.169.0
ARG CLAUDE_CODE_VERSION=2.1.284

RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 jq tini ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" -o /tmp/gh.tgz \
 && tar -xzf /tmp/gh.tgz -C /tmp \
 && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}"

RUN case "${TARGETARCH}" in arm64) arch=aarch64 ;; amd64) arch=x86_64 ;; *) echo "unsupported ${TARGETARCH}" >&2; exit 1 ;; esac \
 && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${arch}-${AWSCLI_VERSION}.zip" -o /tmp/awscli.zip \
 && unzip -q /tmp/awscli.zip -d /tmp \
 && /tmp/aws/install \
 && rm -rf /tmp/aws /tmp/awscli.zip

RUN npm install -g "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

RUN useradd --create-home --uid 10001 --shell /bin/bash bot \
 && mkdir -p /work/src /work/wt /var/lib/slack-review-bot/state /var/lib/slack-review-bot/runs \
 && chown -R bot:bot /work /var/lib/slack-review-bot

# The review-pr skill and the secret-blocking hook, from a pinned aqua-skills commit.
COPY --from=aqua skills/review-pr /opt/aqua-skills/skills/review-pr
COPY --from=aqua security/block-secret-reads.py /opt/aqua-skills/security/block-secret-reads.py

WORKDIR /app
COPY --from=build /src/dist ./dist
COPY package.json ./
COPY scripts ./scripts
COPY claude ./claude
COPY codex ./codex
COPY docker/entrypoint.sh /usr/local/bin/srb-entrypoint

ENV HOME=/home/bot \
    CODEX_HOME=/home/bot/.codex \
    CLAUDE_CONFIG_DIR_REVIEW=/home/bot/.claude-review-bot \
    GH_CONFIG_DIR=/home/bot/.config/gh \
    WORKSPACE_ROOT=/work/src \
    WORKTREE_ROOT=/work/wt \
    RUN_LOG_DIR=/var/lib/slack-review-bot/runs \
    CURSOR_FILE=/var/lib/slack-review-bot/state/cursors.json \
    CODEARTIFACT_REFRESH=false \
    RUNTIME=container

USER bot
# --build: docker build steps have no /.dockerenv; the worker doctor runs the full check (ruling 14).
RUN scripts/install-claude-profile.sh --container --build \
        --skill-src /opt/aqua-skills/skills/review-pr \
        --hook-src /opt/aqua-skills/security/block-secret-reads.py \
 && scripts/install-codex-profile.sh --container --build \
 && mkdir -p /home/bot/.codex/skills /home/bot/.config/gh \
 && chmod 700 /home/bot/.config/gh \
 && ln -s /opt/aqua-skills/skills/review-pr /home/bot/.codex/skills/review-pr

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/srb-entrypoint"]
CMD ["worker"]
