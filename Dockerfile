FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global yt-dlp

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

RUN useradd --system --uid 10001 appuser
USER appuser

EXPOSE 3000
CMD ["npm", "start"]
