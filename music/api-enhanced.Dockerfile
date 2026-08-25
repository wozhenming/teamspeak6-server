# NetEase Cloud Music API (api-enhanced) 镜像
# 构建：docker compose build neteasemusic（或 up -d 自动构建）
# 来源：https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced
# 仅在内网监听（供 panel / music-bot 连接），不暴露宿主端口

FROM node:20-alpine

RUN apk add --no-cache git tini

RUN npm i -g pnpm@9

ENV NODE_ENV=production \
    PORT=3000

RUN git clone --depth 1 https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced.git /app

WORKDIR /app

# 生产依赖（跳过生命周期脚本）；frozen 失败则回退
RUN (pnpm install --frozen-lockfile --prod --ignore-scripts 2>/dev/null || pnpm install --no-frozen-lockfile --prod --ignore-scripts)

EXPOSE 3000

CMD ["/sbin/tini", "--", "node", "app.js"]