FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV APP_ROOT=/workspace
ENV PORT=8800
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    dumb-init \
    git \
    openssl \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    pkg-config \
    libffi-dev \
    libssl-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY deploy/start-in-container.sh /usr/local/bin/start-manju
RUN chmod +x /usr/local/bin/start-manju

EXPOSE 8800

ENTRYPOINT ["dumb-init", "--"]
CMD ["start-manju"]
