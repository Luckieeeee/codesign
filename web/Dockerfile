# syntax=docker/dockerfile:1.7
# ──────────────────────────────────────────────────────────
# Codesign Collaboration Server — runs scripts/collab-server.ts
# (Hocuspocus + Yjs + small REST API on a single port)
# ──────────────────────────────────────────────────────────

FROM oven/bun:1.3.5 AS deps
WORKDIR /app
COPY package.json bun.lock ./
# Production install — ws/bufferutil/utf-8-validate are now in dependencies,
# so they're included even with --production.
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.3.5-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    COLLAB_WS_HOST=0.0.0.0 \
    COLLAB_WS_PORT=1234

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY scripts/ ./scripts/

EXPOSE 1234

# Health endpoint is on the same port as HTTP+WS. Kept as a defence-in-depth
# check; Container Apps also drives its own probes from the Bicep template.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:1234/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["bun", "run", "scripts/collab-server.ts"]
