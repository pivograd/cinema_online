#!/usr/bin/env bash
# Выкладка на свой сервер по ssh (Linux, macOS, Git Bash на Windows):
#   bash scripts/deploy.sh <ssh-хост> [домен]
# Домен нужен в первый раз, дальше сервер помнит его в /opt/cinema/.env. На сервере нужны Docker и Caddy, вход — root.
# Копирует только то, что нужно для работы, в /opt/cinema/releases/<время> и запускает там deploy/install.sh.
set -euo pipefail

HOST=${1:?"использование: bash scripts/deploy.sh <ssh-хост> [домен]"}
DOMAIN=${2:-}
[[ $DOMAIN =~ ^[a-z0-9.-]*$ ]] || { echo "домен — только латиница, цифры, точки и дефисы" >&2; exit 1; }

cd "$(dirname "$0")/.."
REV=$(git describe --always --dirty 2>/dev/null || echo unknown)
REL=/opt/cinema/releases/$(date +%Y%m%d-%H%M%S)

echo "Релиз $REV → $HOST:$REL"
tar -czf - server.js package.json package-lock.json Dockerfile .dockerignore public deploy \
  | ssh "$HOST" "mkdir -p '$REL' && tar -xzf - --no-same-owner --no-same-permissions -C '$REL' && echo '$REV' > '$REL/REVISION'"
ssh "$HOST" "bash '$REL/deploy/install.sh' $DOMAIN"
