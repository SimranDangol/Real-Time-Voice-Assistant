# Multi-stage production Dockerfile for Voice Assistant Server
FROM node:20-alpine AS build

RUN corepack enable && corepack prepare pnpm@10.11.1 --activate

WORKDIR /app

# Copy dependency manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY eval/package.json ./eval/
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/prisma ./apps/server/prisma/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code and build
COPY apps/server ./apps/server
COPY packages/shared ./packages/shared

RUN pnpm --dir apps/server exec prisma generate --schema prisma/schema.prisma \
  && pnpm --filter @voice-assistant/server build

# Production runtime stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

RUN corepack enable && corepack prepare pnpm@10.11.1 --activate

# Copy production manifests and build artifacts
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY eval/package.json ./eval/
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/prisma ./apps/server/prisma
COPY --from=build /app/apps/server/dist ./apps/server/dist

# Install production-only dependencies
RUN pnpm --filter @voice-assistant/server install --prod --frozen-lockfile \
  && pnpm --dir apps/server exec prisma generate --schema prisma/schema.prisma

# Run as non-root user for security
ENV LOG_FILE_PATH=/tmp/voice-assistant/server.log
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN mkdir -p /tmp/voice-assistant /home/node/.cache \
  && chown -R node:node /app /tmp/voice-assistant /home/node
USER node

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget --spider -q http://localhost:8080/health || exit 1

CMD ["sh", "-c", "pnpm --dir apps/server exec prisma migrate deploy --schema prisma/schema.prisma && node apps/server/dist/index.js"]
