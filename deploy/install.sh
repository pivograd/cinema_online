#!/usr/bin/env bash
# Ставит релиз кинозала на сервер. Вызывается из scripts/deploy.sh; руками — из каталога релиза, от root:
#   bash deploy/install.sh [домен]
# Домен нужен в первый раз (и чтобы сменить его), дальше берётся из /opt/cinema/.env.
# Порядок: проверить сайт в Caddy → собрать и запустить контейнер (не поднялся — вернуть прошлый релиз) →
# переключить current → поставить сайт в Caddy. Идемпотентен: .env с логинами, паролями и ключом сессий создаёт
# только если его нет, Caddy перезагружает только при изменениях, оставляет три последних релиза.
set -euo pipefail

CINEMA_HOME=${CINEMA_HOME:-/opt/cinema}
ENV_FILE=$CINEMA_HOME/.env
REL=$(cd "$(dirname "$0")/.." && pwd -P) # настоящий путь релиза, а не через симлинк current
DOMAIN_ARG=${1:-}
NODE_UID=1000 # пользователь node в образе: ему нужна запись в state/

log() { printf '\n== %s\n' "$*"; }
die() { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }
# put <файл> <права>: содержимое со stdin; файл меняется, только если отличается (тогда код 0)
put() {
  local tmp; tmp=$(mktemp)
  cat >"$tmp"
  if cmp -s "$tmp" "$1"; then rm -f "$tmp"; return 1; fi
  install -D -m "$2" "$tmp" "$1"; rm -f "$tmp"
}

[[ $EUID -eq 0 ]] || die "запускать от root"
docker compose version >/dev/null 2>&1 || die "нужен Docker с плагином compose"
systemctl is-active --quiet caddy || die "нужен запущенный Caddy (пакет caddy)"
[[ -z $DOMAIN_ARG || $DOMAIN_ARG =~ ^[a-z0-9.-]+$ ]] || die "домен «$DOMAIN_ARG» — только латиница, цифры, точки и дефисы"
# скрипты релиза root запускает сам: писать в них не должен никто другой, какие бы права ни пришли в архиве
chmod -R go-w "$REL"

log "Настройки: $ENV_FILE"
install -d -m 755 "$CINEMA_HOME/media"
install -d -m 700 -o "$NODE_UID" -g "$NODE_UID" "$CINEMA_HOME/state"
if [[ ! -f $ENV_FILE ]]; then
  [[ -n $DOMAIN_ARG ]] || die "первый запуск: укажите домен, например bash deploy/install.sh kino.example.ru"
  # пароль под телефонную клавиатуру: 12 строчных знаков без похожих (0/o, 1/l/i), группами по 4
  pw() {
    local s; s=$(LC_ALL=C tr -dc 'abcdefghjkmnpqrstuvwxyz23456789' </dev/urandom | head -c 12 || true)
    printf '%s-%s-%s' "${s:0:4}" "${s:4:4}" "${s:8:4}"
  }
  put "$ENV_FILE" 600 <<EOF || true
# Кинозал «Свет в окне». После правки: bash $CINEMA_HOME/current/deploy/install.sh
CINEMA_DOMAIN=$DOMAIN_ARG
# логин:пароль;логин:пароль. Логин второй зритель видит в плеере («anna: пауза»)
USERS=zritel1:$(pw);zritel2:$(pw)
# ключ подписи cookie; если сменить, вход слетит на всех устройствах
SESSION_SECRET=$(openssl rand -hex 32)
SESSION_DAYS=30
EOF
  echo "создан: логины и пароли — cat $ENV_FILE"
fi
# новый домен записываем в .env только после того, как его примет Caddy
DOMAIN=${DOMAIN_ARG:-$(sed -n 's/^CINEMA_DOMAIN=//p' "$ENV_FILE")}
[[ $DOMAIN =~ ^[a-z0-9.-]+$ ]] || die "CINEMA_DOMAIN в $ENV_FILE пустой или с недопустимыми символами"

log "Проверка сайта в Caddy: $DOMAIN"
# /etc/caddy/Caddyfile может вести другой проект (на этом сервере его переписывает bootstrap mbkas), поэтому его
# не трогаем: Caddy стартует с main.Caddyfile, который подключает и его, и каждый сайт из /etc/caddy/sites/.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
sed "s|__DOMAIN__|$DOMAIN|g" "$REL/deploy/cinema.caddy" >"$stage/cinema.caddy"
printf 'import /etc/caddy/Caddyfile\nimport %s\n' "$stage/cinema.caddy" >"$stage/check.Caddyfile"
chmod -R a+rX "$stage"
# проверяем от пользователя caddy: от root validate создал бы лог-файл, который Caddy потом не сможет открыть
if ! runuser -u caddy -- caddy validate --config "$stage/check.Caddyfile" --adapter caddyfile >"$stage/validate.log" 2>&1; then
  cat "$stage/validate.log" >&2
  die "Caddy не принял сайт $DOMAIN (например, домен уже занят другим сайтом). Ничего не меняли"
fi
if [[ -n $DOMAIN_ARG ]] && ! grep -qxF "CINEMA_DOMAIN=$DOMAIN" "$ENV_FILE"; then
  sed -i "s/^CINEMA_DOMAIN=.*/CINEMA_DOMAIN=$DOMAIN/" "$ENV_FILE"
fi

log "Контейнер (релиз $(cat "$REL/REVISION" 2>/dev/null || echo '?'))"
prev=$(readlink -f "$CINEMA_HOME/current" 2>/dev/null || true)
compose() { CINEMA_HOME=$CINEMA_HOME docker compose -f "$1/deploy/compose.yaml" "${@:2}"; }
# сборка до остановки старого контейнера: упадёт сборка — зрители этого не заметят
compose "$REL" build
compose "$REL" up -d --remove-orphans
healthy=0
for _ in $(seq 1 30); do
  if curl -fs -o /dev/null http://127.0.0.1:3000/health; then healthy=1; break; fi
  sleep 1
done
if [[ $healthy != 1 ]]; then
  compose "$REL" logs --tail 40 || true
  if [[ -n $prev && $prev != "$REL" && -f $prev/deploy/compose.yaml ]]; then
    echo "возвращаю прошлый релиз: $prev"
    compose "$prev" up -d --build --remove-orphans || true
  fi
  die "новый релиз не ответил на /health за 30 с"
fi
ln -sfn "$REL" "$CINEMA_HOME/current"
echo "отвечает на 127.0.0.1:3000"

log "Caddy: https://$DOMAIN"
caddy_bin=$(command -v caddy)
changed=0
put /etc/caddy/sites/cinema.caddy 644 <"$stage/cinema.caddy" && changed=1
put /etc/caddy/main.Caddyfile 644 <<'EOF' && changed=1
# Точка входа Caddy на этом сервере (systemd: /etc/systemd/system/caddy.service.d/sites.conf; ставит
# deploy/install.sh кинозала). /etc/caddy/Caddyfile подключается как есть — его ведёт свой проект;
# каждый дополнительный сайт лежит отдельным файлом в /etc/caddy/sites/.
#
# HTTP/3 выключен для всего сервера: на маршруте от этого хостинга QUIC теряет пакеты, и Safari тянул видео
# кусками по 64 КБ с обрывами (69% запросов), а по HTTP/2 те же телефоны качают в десятки раз быстрее.
# Глобальные опции обязаны идти первыми: если в /etc/caddy/Caddyfile появится свой глобальный блок
# (например, email у mbkas), его содержимое нужно перенести сюда, иначе Caddy не примет конфиг.
{
	servers {
		protocols h1 h2
	}
}

import /etc/caddy/Caddyfile
import /etc/caddy/sites/*.caddy
EOF
if put /etc/systemd/system/caddy.service.d/sites.conf 644 <<EOF
# Caddy читает /etc/caddy/main.Caddyfile: в нём /etc/caddy/Caddyfile и сайты из /etc/caddy/sites/ (кинозал).
[Service]
ExecStart=
ExecStart=$caddy_bin run --environ --config /etc/caddy/main.Caddyfile --adapter caddyfile
ExecReload=
ExecReload=$caddy_bin reload --config /etc/caddy/main.Caddyfile --adapter caddyfile --force
EOF
then
  systemctl daemon-reload
  changed=1
fi
# сверяемся и с тем, что реально работает: прошлый запуск мог оборваться между записью файлов и перезагрузкой
if [[ $(systemctl show -p NeedDaemonReload --value caddy) == yes ]]; then systemctl daemon-reload; changed=1; fi
live=$(curl -fsS http://127.0.0.1:2019/config/ || true)
grep -F "\"$DOMAIN\"" <<<"$live" >/dev/null || changed=1
if [[ $changed == 1 ]]; then
  systemctl reload caddy
  echo "Caddy перечитал конфиг"
else
  echo "конфиг Caddy не менялся"
fi
systemctl is-active --quiet caddy || die "Caddy не запущен: journalctl -u caddy -n 50"
live=$(curl -fsS http://127.0.0.1:2019/config/ || true)
grep -F "\"$DOMAIN\"" <<<"$live" >/dev/null || die "в работающем Caddy нет сайта $DOMAIN: journalctl -u caddy -n 50"

resolved=$(getent ahostsv4 "$DOMAIN" | awk 'NR == 1 { print $1 }' || true)
if [[ -z $resolved ]] || ! hostname -I | tr ' ' '\n' | grep -xF "$resolved" >/dev/null; then
  echo "ВНИМАНИЕ: $DOMAIN пока не указывает на этот сервер (${resolved:-нет записи})."
  echo "Заведите A-запись на IP сервера — сертификат Caddy выпустит сам, как только она заработает."
fi

log "Уборка"
find "$CINEMA_HOME/releases" -mindepth 1 -maxdepth 1 -type d ! -path "$REL" -printf '%T@ %p\n' \
  | sort -rn | tail -n +3 | cut -d' ' -f2- | xargs -r rm -rf
docker image prune -f --filter label=org.opencontainers.image.title=cinema-online >/dev/null
echo "оставлены три последних релиза"

# фильмы лежат на том же диске, что и всё остальное на сервере (у соседних проектов там базы данных)
free_gb=$(df --output=avail -BG "$CINEMA_HOME/media" | tail -1 | tr -dc 0-9)
echo "свободно на диске: ${free_gb} ГБ"
(( free_gb >= 15 )) || echo "ВНИМАНИЕ: места мало. Удалите просмотренные фильмы: диск общий с другими сервисами"
stale=$(find "$CINEMA_HOME/media" -maxdepth 1 -name '*.part' -mmin +240 -printf '  %p (%s байт)\n')
[[ -z $stale ]] || printf 'Недокачанные файлы, не менялись больше 4 часов (удалите, если загрузка прервалась):\n%s\n' "$stale"

log "Готово: https://$DOMAIN"
echo "Фильмы: $CINEMA_HOME/media (mp4 H.264 + AAC, рядом .srt/.vtt). Перезапуск после загрузки не нужен."
