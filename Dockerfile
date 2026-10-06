# Образ кинозала: Node и одна зависимость ws. На сервере собирается через deploy/compose.yaml.
# Полная ICU в официальном образе нужна субтитрам: старые русские .srt читаются как windows-1251.
ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title=cinema-online
ENV NODE_ENV=production PORT=3000 MEDIA_DIR=/media
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js ./
COPY public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.js"]
