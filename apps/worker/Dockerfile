# syntax=docker/dockerfile:1.7
# ---- deps: full install for the TypeScript build ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ----
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime: small, non-root, prod deps only ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 4001
HEALTHCHECK --interval=15s --timeout=3s --start-period=40s --retries=5 CMD wget -qO- http://127.0.0.1:4001/health || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
