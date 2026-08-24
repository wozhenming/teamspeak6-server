# TeamSpeak 6 管理面板镜像
# 构建：docker build -t ts6-panel:local ./panel（或直接 docker compose up -d 自动构建）

FROM node:20-alpine

# docker CLI：经挂载的 /var/run/docker.sock 操作主机 Docker
# （读取 TS6 容器日志/初始凭证、容器快捷启停）
RUN apk add --no-cache docker-cli

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "src/server.js"]
