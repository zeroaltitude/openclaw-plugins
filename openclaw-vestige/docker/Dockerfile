# ── LEGACY: Single-container Dockerfile (deprecated) ─────────────────────────
#
# This Dockerfile is kept for backwards compatibility but is no longer the
# recommended deployment. Use the split Dockerfiles instead:
#
#   - Dockerfile.vestige  — Vestige MCP server + supergateway (Streamable HTTP)
#   - Dockerfile.bridge   — FastAPI HTTP bridge (connects to Vestige over HTTP)
#
# See docker-compose.yml for the recommended two-service setup.
# ──────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Download vestige pre-built binaries ─────────────────────────────
FROM ubuntu:24.04 AS downloader

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG VESTIGE_VERSION=v1.1.2

# SHA256 of vestige-mcp-x86_64-unknown-linux-gnu.tar.gz for VESTIGE_PINNED_VERSION.
# Verified 2026-08-04 two ways: local sha256sum of the downloaded tarball, and the
# GitHub release asset digest (GET /repos/samvallad33/vestige/releases/assets/346525108).
# Re-pin with:
#   curl -fsSL "https://github.com/samvallad33/vestige/releases/download/<tag>/vestige-mcp-x86_64-unknown-linux-gnu.tar.gz" | sha256sum
# NOTE: this is a third-party release. Prefer a first-party artifact built by
# vestige's own .github/workflows/release.yml when one is available.
ARG VESTIGE_PINNED_VERSION=v1.1.2
ARG VESTIGE_SHA256="6fa9e214f956a75b9daa815f3042b533ae3656e7dea1ee797c8a2af6e8e528a8"

# Download, verify checksum, then extract. A checksum mismatch MUST fail the build.
RUN set -eu; \
    case "${VESTIGE_SHA256}" in \
      ""|*PLACEHOLDER*|*TODO*) \
        echo "ERROR: VESTIGE_SHA256 is not pinned to a real checksum. Refusing to install an unverified binary." >&2; \
        exit 1 ;; \
    esac; \
    if [ "${VESTIGE_VERSION}" != "${VESTIGE_PINNED_VERSION}" ]; then \
      echo "ERROR: VESTIGE_VERSION=${VESTIGE_VERSION} but the pinned checksum is for ${VESTIGE_PINNED_VERSION}." >&2; \
      echo "       Pass both --build-arg VESTIGE_PINNED_VERSION=${VESTIGE_VERSION} and --build-arg VESTIGE_SHA256=<sha256 of that tarball>." >&2; \
      exit 1; \
    fi; \
    curl -fsSL --proto '=https' --tlsv1.2 -o /tmp/vestige.tar.gz \
      "https://github.com/samvallad33/vestige/releases/download/${VESTIGE_VERSION}/vestige-mcp-x86_64-unknown-linux-gnu.tar.gz"; \
    echo "${VESTIGE_SHA256}  /tmp/vestige.tar.gz" | sha256sum -c -; \
    tar -xz -C /usr/local/bin/ -f /tmp/vestige.tar.gz; \
    chmod +x /usr/local/bin/vestige-mcp /usr/local/bin/vestige /usr/local/bin/vestige-restore; \
    rm -f /tmp/vestige.tar.gz


# ── Stage 2: Runtime (Ubuntu 24.04 for GLIBC 2.39 compat) ────────────────────
FROM ubuntu:24.04

# Install Python 3.12 + minimal deps
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user with explicit UID/GID matching Helm securityContext
RUN groupadd --gid 1000 vestige \
    && useradd --uid 1000 --gid 1000 -m -s /bin/bash vestige

# Copy vestige binaries from downloader
COPY --from=downloader /usr/local/bin/vestige-mcp /usr/local/bin/vestige-mcp
COPY --from=downloader /usr/local/bin/vestige     /usr/local/bin/vestige
COPY --from=downloader /usr/local/bin/vestige-restore /usr/local/bin/vestige-restore

# Install Python dependencies
WORKDIR /app
COPY server/requirements.txt .
RUN python3 -m pip install --no-cache-dir --break-system-packages -r requirements.txt

# Copy server code
COPY server/app/ ./app/

# Data directory for SQLite + embedding cache
# Embedding cache lives under /data so it persists on PVC mounts
RUN mkdir -p /data/.cache/vestige/fastembed && \
    chown -R vestige:vestige /data /app

ENV VESTIGE_DATA_DIR=/data \
    FASTEMBED_CACHE_PATH=/data/.cache/vestige/fastembed \
    LOG_LEVEL=info

EXPOSE 8000
USER vestige

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["python3", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
