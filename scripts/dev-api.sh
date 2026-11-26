#!/bin/sh
# Backend for development: auto-reload, data kept in ./.marthouse-data, no launch token (Vite proxies to it).
cd "$(dirname "$0")/../backend"
export MARTHOUSE_DATA_DIR="${MARTHOUSE_DATA_DIR:-$(cd .. && pwd)/.marthouse-data}"
export MARTHOUSE_NO_TOKEN=1
export MARTHOUSE_EXTRA_HOSTS="localhost:5180,127.0.0.1:5180"
exec .venv/bin/uvicorn marthouse.main:app --host 127.0.0.1 --port "${MARTHOUSE_PORT:-8765}" --reload --reload-dir marthouse
