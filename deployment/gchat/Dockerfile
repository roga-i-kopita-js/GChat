# syntax=docker/dockerfile:1
ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm-slim AS dependencies
WORKDIR /src
COPY . .
RUN corepack enable && corepack install \
    && pnpm install --frozen-lockfile

FROM dependencies AS backend-build
RUN pnpm --filter @gchat/backend build \
    && pnpm --config.inject-workspace-packages=true --filter @gchat/backend --prod deploy /out \
    && cp -r applications/backend/dist /out/dist \
    && cp -r applications/backend/drizzle /out/drizzle

FROM dependencies AS web-build
RUN pnpm --filter @gchat/web build:server \
    && test -s applications/web/dist/index.html \
    && test -d applications/web/dist/static \
    && test -s applications/web/dist/sw.js \
    && test -s applications/web/dist/site.webmanifest \
    && test -s applications/web/dist/icons/icon-192.png \
    && test -s applications/web/dist/icons/icon-512.png \
    && test -s applications/web/dist/icons/maskable-512.png

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 GCHAT_WEB_ROOT=/app/web
WORKDIR /app
COPY --from=backend-build --chown=node:node /out/package.json ./package.json
COPY --from=backend-build --chown=node:node /out/node_modules ./node_modules
COPY --from=backend-build --chown=node:node /out/dist ./dist
COPY --from=backend-build --chown=node:node /out/drizzle ./drizzle
COPY --from=web-build --chown=node:node /src/applications/web/dist ./web
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=4s --start-period=20s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:3000/ready',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
