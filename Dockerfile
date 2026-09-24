# OptMap — приложение (граф загружается томом: -v ./data:/app/data)
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 8787

# Если data/ пуст, при старте будет сгенерирован демо-город.
# Для боевого режима положите граф: docker cp / смонтируйте data/graph.json.gz
CMD ["node", "server/index.js"]
