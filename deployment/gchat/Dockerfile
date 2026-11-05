# syntax=docker/dockerfile:1
ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /src
COPY . .
RUN corepack enable && corepack install \
    && pnpm install --frozen-lockfile \
    && pnpm --filter @gchat/backend build \
    && pnpm --filter @gchat/web build:server \
    && pnpm --config.inject-workspace-packages=true --filter @gchat/backend --prod deploy /out \
    && cp -r applications/backend/dist /out/dist \
    && cp -r applications/backend/drizzle /out/drizzle \
    && cp -r applications/web/dist /out/web

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 GCHAT_WEB_ROOT=/app/web
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/drizzle ./drizzle
COPY --from=build --chown=node:node /out/web ./web
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=4s --start-period=20s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:3000/ready',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
