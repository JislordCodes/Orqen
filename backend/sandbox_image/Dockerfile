# Image every user's sandbox container is created from.
# Build:  docker build -t appbuilder-sandbox:latest sandbox_image
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv git curl ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
