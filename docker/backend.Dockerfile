FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends aapt zip apksigner zipalign apktool default-jre-headless curl unzip ca-certificates \
    && (apt-get install -y --no-install-recommends jadx \
        || (curl -fsSL -o /tmp/jadx.zip https://github.com/skylot/jadx/releases/download/v1.5.0/jadx-1.5.0.zip \
            && mkdir -p /opt/jadx && unzip -q /tmp/jadx.zip -d /opt/jadx && ln -s /opt/jadx/bin/jadx /usr/local/bin/jadx && rm /tmp/jadx.zip)) \
    && rm -rf /var/lib/apt/lists/*
ENV JAVA_TOOL_OPTIONS="-Xmx200m"
WORKDIR /app
COPY backend/package.json ./
RUN npm install
COPY backend/ ./
RUN npm run build && cp src/db/*.sql dist/db/
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "dist/server.js"]
