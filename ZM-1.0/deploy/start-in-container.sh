#!/usr/bin/env bash
set -Eeuo pipefail

PORT="${PORT:-8800}"
APP_ROOT="${APP_ROOT:-/workspace}"
APP_DIR="${1:-${APP_DIR:-}}"

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

find_app_dir() {
  local candidates=(
    "${APP_DIR}"
    "${PWD}"
    "${PWD}/ZM-1.0"
    "${APP_ROOT}"
    "${APP_ROOT}/ZM-1.0"
    "${APP_ROOT}/app"
    "${APP_ROOT}/app/ZM-1.0"
    "${APP_ROOT}/manju"
    "${APP_ROOT}/manju/ZM-1.0"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -n "$candidate" && -f "${candidate}/server.js" && -f "${candidate}/package.json" ]]; then
      realpath "$candidate"
      return 0
    fi
  done

  find "$APP_ROOT" -maxdepth 4 -type f -name package.json -print 2>/dev/null \
    | while read -r package_file; do
        local dir
        dir="$(dirname "$package_file")"
        if [[ -f "${dir}/server.js" ]]; then
          realpath "$dir"
          return 0
        fi
      done
}

APP_DIR="$(find_app_dir || true)"
if [[ -z "$APP_DIR" ]]; then
  cat >&2 <<EOF
Cannot find the Manju app directory.

Expected a directory containing both server.js and package.json.

Typical setup inside the container:
  cd /workspace
  vi .env
  git clone <YOUR_REPO_URL> app

If your repository contains ZM-1.0, start with:
  APP_DIR=/workspace/app/ZM-1.0 PORT=8800 start-manju

If you cloned to another path, pass it explicitly:
  start-manju /workspace/path/to/ZM-1.0
EOF
  exit 1
fi

if [[ ! -f "${APP_DIR}/server.js" || ! -f "${APP_DIR}/package.json" ]]; then
  echo "Invalid APP_DIR: ${APP_DIR}. Missing server.js or package.json." >&2
  exit 1
fi

load_env_file "${APP_ROOT}/.env"
load_env_file "$(dirname "$APP_DIR")/.env"
load_env_file "${APP_DIR}/.env"

export PORT
export NODE_ENV="${NODE_ENV:-production}"
export SEEDANCE_PYTHON="${SEEDANCE_PYTHON:-python3}"

cd "$APP_DIR"
mkdir -p generated-videos tmp

echo "[start-manju] app dir: ${APP_DIR}"
echo "[start-manju] port: ${PORT}"
echo "[start-manju] node: $(node --version)"
echo "[start-manju] npm: $(npm --version)"
echo "[start-manju] python: $(python3 --version)"

if [[ -f package-lock.json ]]; then
  echo "[start-manju] installing Node dependencies with npm ci --omit=dev"
  npm ci --omit=dev
else
  echo "[start-manju] installing Node dependencies with npm install --omit=dev"
  npm install --omit=dev
fi

if [[ -f requirements-seedance.txt ]]; then
  if [[ ! -d python_deps || "${FORCE_INSTALL_SEEDANCE:-0}" == "1" ]]; then
    echo "[start-manju] installing Seedance Python dependencies into ./python_deps"
    python3 -m pip install --no-cache-dir --target ./python_deps -r requirements-seedance.txt
  else
    echo "[start-manju] existing ./python_deps found; skip Python dependency install"
  fi
fi

echo "[start-manju] starting Node server"
exec node server.js
