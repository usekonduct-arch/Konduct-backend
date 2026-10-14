# Render runs the backend as one Express server (functions/src/server.ts) instead of Cloud Functions.
FROM node:22-slim AS build
WORKDIR /app
COPY functions/package.json functions/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY functions/tsconfig.json ./
COPY functions/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/lib ./lib
# No `USER node`: Render mounts secret files (the service-account key) for root only, and a non-root
# server can't read them, so it can't verify any sign-in.
EXPOSE 8080
CMD ["node", "lib/server.js"]
