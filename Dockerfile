FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV DENO_INSTALL=/usr/local

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates curl unzip \
    && curl -fsSL https://deno.land/install.sh | sh \
    && python3 -m pip install --break-system-packages --no-cache-dir --upgrade "yt-dlp[default]" \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

RUN useradd --system --uid 10001 appuser
USER appuser

EXPOSE 3000
CMD ["npm", "start"]
