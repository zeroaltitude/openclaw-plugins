# ── Stage 1: Download vestige pre-built binaries ─────────────────────────────
FROM ubuntu:24.04 AS downloader

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG VESTIGE_VERSION=v1.1.2
RUN curl -fsSL \
      "https://github.com/samvallad33/vestige/releases/download/${VESTIGE_VERSION}/vestige-mcp-x86_64-unknown-linux-gnu.tar.gz" \
    | tar -xz -C /usr/local/bin/ \
    && chmod +x /usr/local/bin/vestige-mcp /usr/local/bin/vestige /usr/local/bin/vestige-restore


# ── Stage 2: Runtime (Ubuntu 24.04 for GLIBC 2.39 compat) ────────────────────
FROM ubuntu:24.04

# Install Python 3.12 + minimal deps
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r vestige && useradd -r -g vestige -m -s /bin/bash vestige

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
RUN mkdir -p /data /home/vestige/.cache/vestige/fastembed && \
    chown -R vestige:vestige /data /home/vestige/.cache /app

ENV VESTIGE_DATA_DIR=/data \
    FASTEMBED_CACHE_PATH=/home/vestige/.cache/vestige/fastembed \
    VESTIGE_BINARY=vestige-mcp \
    LOG_LEVEL=info

EXPOSE 8000
USER vestige

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["python3", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
