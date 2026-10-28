# Orqen API (FastAPI). Stateless: talks to Redis, reads snapshot metadata from S3 (or a shared
# SNAPSHOT_DIR) and proxies preview traffic to worker hosts. It never needs the LLM key or Docker.
#   docker build -t orqen-api -f backend/Dockerfile backend
FROM python:3.12-slim-bookworm AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build
COPY requirements.txt .
RUN python -m venv /opt/venv && /opt/venv/bin/pip install -r requirements.txt

FROM python:3.12-slim-bookworm
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    APP_ENV=production LOG_FORMAT=json \
    UVICORN_WORKERS=2 PORT=8000
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin orqen
COPY --from=build /opt/venv /opt/venv
WORKDIR /app
COPY --chown=orqen:orqen app ./app
USER orqen
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/live" || exit 1
# --proxy-headers + forwarded-allow-ips: trust X-Forwarded-* from the ALB / Caddy in front.
# timeout-keep-alive above the ALB's idle timeout avoids 502s on reused connections.
CMD ["sh", "-c", "exec uvicorn app.api:app --host 0.0.0.0 --port ${PORT} --workers ${UVICORN_WORKERS} --proxy-headers --forwarded-allow-ips='*' --timeout-keep-alive 3700 --no-server-header --no-access-log"]
