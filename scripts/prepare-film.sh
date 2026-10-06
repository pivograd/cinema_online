#!/usr/bin/env bash
# Готовит фильм для кинозала: mp4 для прямого просмотра, HLS в двух качествах и субтитры рядом.
#   bash scripts/prepare-film.sh <исходник> <имя> [номер звуковой дорожки, с нуля]
#   bash scripts/prepare-film.sh ~/Downloads/film.mkv I.Swear.2025 0
# Номер дорожки смотрите в `ffprobe <исходник>`: звук идёт как Stream #0:N(rus): Audio, считаются только звуковые.
# Результат в media/ (или в $MEDIA_DIR):
#   <имя>.mp4            720p, faststart: его видит список фильмов, им же играет браузер без HLS
#   <имя>.hls/           master.m3u8 + 720p/ и 480p/ (fMP4-сегменты по 4 с): плеер переключает качество сам
#   <имя>.<язык>.srt     текстовые субтитры из исходника (ru, en, uk, de, fr, es), без SDH
# Ключевой кадр ровно каждые 2 с и потолок битрейта: перемотка и подстройка синхронизации не ждут
# докачки длинной группы кадров, а пики в сцене с движением не обгоняют канал.
set -euo pipefail

SRC=${1:?"использование: bash scripts/prepare-film.sh <исходник> <имя> [звуковая дорожка]"}
NAME=${2:?"укажите имя, например I.Swear.2025: из него плеер берёт название и год"}
AUDIO=${3:-0}
[[ -f $SRC ]] || { echo "нет файла: $SRC" >&2; exit 1; }
[[ $NAME =~ ^[A-Za-z0-9._-]+$ ]] || { echo "имя — латиница, цифры, точки, дефисы, подчёркивания" >&2; exit 1; }
command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || { echo "нужны ffmpeg и ffprobe в PATH" >&2; exit 1; }

cd "$(dirname "$0")/.."
OUT=${MEDIA_DIR:-media}
WORK=$OUT/$NAME.work # всё собираем рядом и переносим в конце: недоделанный фильм не попадёт в список
rm -rf "$WORK"
mkdir -p "$WORK/hls/720p" "$WORK/hls/480p"
SRC_ABS=$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")

# один проход декодирования на оба качества; звук — стерео AAC одинаковый в обоих, чтобы смена качества не щёлкала
VIDEO=(-c:v libx264 -preset slow -profile:v high -pix_fmt yuv420p -force_key_frames 'expr:gte(t,n_forced*2)' -sc_threshold 0)
TAIL=(-c:a aac -b:a 128k -ac 2 -map_metadata -1 -map_chapters -1 -movflags +faststart)
echo "== Перекодирование (720p и 480p)"
ffmpeg -nostdin -hide_banner -loglevel warning -stats -y -i "$SRC_ABS" \
  -filter_complex "[0:v:0]split=2[hd][sd0];[sd0]scale=854:-2[sd]" \
  -map "[hd]" -map "0:a:$AUDIO" "${VIDEO[@]}" -level:v 4.0 -crf 21 -maxrate 3500k -bufsize 7000k "${TAIL[@]}" "$WORK/720p.mp4" \
  -map "[sd]" -map "0:a:$AUDIO" "${VIDEO[@]}" -level:v 3.1 -crf 23 -maxrate 1500k -bufsize 3000k "${TAIL[@]}" "$WORK/480p.mp4"

echo "== Нарезка HLS"
master="#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS"
for q in 720p 480p; do
  (cd "$WORK/hls/$q" && ffmpeg -nostdin -hide_banner -loglevel error -y -i "../../$q.mp4" -map 0 -c copy \
    -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 -hls_flags independent_segments \
    -hls_fmp4_init_filename init.mp4 -hls_segment_filename 'seg_%05d.m4s' index.m3u8)
  # BANDWIDTH — самый тяжёлый сегмент, AVERAGE-BANDWIDTH — среднее: так их считает Apple
  rates=$(cd "$WORK/hls/$q" && awk -F: '/^#EXTINF/ { d = $2 + 0; next }
    /^seg_/ { cmd = "wc -c < " $0; cmd | getline b; close(cmd); r = b * 8 / d; if (r > peak) peak = r; bits += b * 8; dur += d }
    END { printf "%d %d", peak, bits / dur }' index.m3u8)
  read -r peak avg <<<"$rates"
  read -r w h level fps <<<"$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,level,avg_frame_rate \
    -of default=nw=1:nk=1 "$WORK/$q.mp4" | tr -d '\r' | tr '\n' ' ' | awk '{ split($4, f, "/"); printf "%s %s %s %.3f", $1, $2, $3, f[1] / f[2] }')"
  master+="
#EXT-X-STREAM-INF:BANDWIDTH=$peak,AVERAGE-BANDWIDTH=$avg,RESOLUTION=${w}x$h,FRAME-RATE=$fps,CODECS=\"avc1.6400$(printf '%02x' "$level"),mp4a.40.2\"
$q/index.m3u8"
  echo "$q: ${w}x$h, в среднем $((avg / 1000)) кбит/с, пик сегмента $((peak / 1000)) кбит/с"
done
printf '%s\n' "$master" >"$WORK/hls/master.m3u8"

echo "== Субтитры"
while IFS=, read -r idx codec lang title; do
  [[ $codec == subrip && ! ${title:-} =~ SDH ]] || continue
  case ${lang:-} in
    rus) short=ru ;; eng) short=en ;; ukr) short=uk ;; ger | deu) short=de ;; fre | fra) short=fr ;; spa) short=es ;;
    *) continue ;;
  esac
  [[ -e $WORK/$NAME.$short.srt ]] && continue # первая дорожка языка — обычно полная
  ffmpeg -nostdin -hide_banner -loglevel error -y -i "$SRC_ABS" -map "0:$idx" -c:s copy "$WORK/$NAME.$short.srt"
  echo "$NAME.$short.srt${title:+ ($title)}"
done < <(ffprobe -v error -select_streams s -show_entries stream=index,codec_name:stream_tags=language,title -of csv=p=0 "$SRC_ABS" | tr -d '\r') # ffmpeg под Windows пишет CRLF

echo "== В $OUT/"
rm -rf "${OUT:?}/$NAME.hls"
mv "$WORK/hls" "$OUT/$NAME.hls"
mv "$WORK/720p.mp4" "$OUT/$NAME.mp4"
for f in "$WORK"/*.srt; do
  if [[ -e $f ]]; then mv "$f" "$OUT/"; fi
done
rm -rf "$WORK"
ls -la "$OUT" | grep -F "$NAME"
du -sh "$OUT/$NAME.mp4" "$OUT/$NAME.hls"
