#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE="${IMAGE:-manju-agent-runtime:latest}"
NAME="${NAME:-manju-agent}"
HOST_PORT="${HOST_PORT:-8800}"
CONTAINER_PORT="${CONTAINER_PORT:-8800}"
DATA_DIR="${DATA_DIR:-/opt/manju-agent}"
APP_DIR="${APP_DIR:-/workspace/app/ZM-1.0}"
MODE="${1:-app}"

if [[ "$MODE" != "app" && "$MODE" != "setup" && "$MODE" != "shell" ]]; then
  echo "Usage: $0 [app|setup|shell]"
  echo
  echo "  setup  Start an empty persistent container so you can exec into it, write .env, and git clone."
  echo "  app    Start the app on port ${HOST_PORT}->${CONTAINER_PORT} using APP_DIR=${APP_DIR}."
  echo "  shell  Open a shell in the running container."
  exit 2
fi

if [[ "$MODE" == "shell" ]]; then
  exec docker exec -it "$NAME" bash
fi

mkdir -p "$DATA_DIR"

docker build -t "$IMAGE" -f "${PROJECT_DIR}/deploy/Dockerfile" "$PROJECT_DIR"

docker rm -f "$NAME" >/dev/null 2>&1 || true

if [[ "$MODE" == "setup" ]]; then
  docker run -d \
    --name "$NAME" \
    --restart unless-stopped \
    -p "${HOST_PORT}:${CONTAINER_PORT}" \
    -v "${DATA_DIR}:/workspace" \
    -w /workspace \
    "$IMAGE" \
    sleep infinity

  cat <<EOF
Setup container started: ${NAME}

Next:
  docker exec -it ${NAME} bash
  cd /workspace
  vi .env
  git clone <YOUR_REPO_URL> app

After the code is ready, restart as the app container:
  APP_DIR=${APP_DIR} HOST_PORT=${HOST_PORT} CONTAINER_PORT=${CONTAINER_PORT} ${PROJECT_DIR}/deploy/run-container.sh app
EOF
  exit 0
fi

docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  -v "${DATA_DIR}:/workspace" \
  -e "APP_DIR=${APP_DIR}" \
  -e "PORT=${CONTAINER_PORT}" \
  -e "NODE_ENV=production" \
  "$IMAGE"

cat <<EOF
App container started: ${NAME}

URL from this host:
  http://127.0.0.1:${HOST_PORT}

Health check:
  curl http://127.0.0.1:${HOST_PORT}/api/health

Logs:
  docker logs -f ${NAME}
EOF
