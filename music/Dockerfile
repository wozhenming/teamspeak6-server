FROM node:20-alpine
WORKDIR /app
COPY package.json ./
# 国内网络自动回退镜像源
RUN npm install --no-audit --no-fund \
    || (npm config set registry https://registry.npmmirror.com \
        && npm install --no-audit --no-fund)
# 转码音频为稳定 MP3 流（点歌机器人作为电台源拉流所需）
RUN apk add --no-cache ffmpeg
COPY src ./src
ENV NODE_ENV=production
EXPOSE 3200
CMD ["node", "src/index.js"]