FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000

USER node
CMD ["node", "server/index.js"]
