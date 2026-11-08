# Streetkey: website + API in one container (for Fly.io, Railway, a VPS, etc.).
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:all

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/dist ./server/dist
COPY server/migrations ./server/migrations
USER node
EXPOSE 8787
CMD ["node", "server/dist/index.js"]
