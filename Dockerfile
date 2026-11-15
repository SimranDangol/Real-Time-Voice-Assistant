# Multi-stage production Dockerfile for Voice Assistant Server
FROM node:20-alpine AS build

RUN corepack enable && corepack prepare pnpm@10.11.1 --activate

WORKDIR /app

# Copy dependency manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code and build
COPY apps/server ./apps/server
COPY tsconfig.json* ./

RUN pnpm --filter @voice-assistant/server build

# Production runtime stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

RUN corepack enable && corepack prepare pnpm@10.11.1 --activate

# Copy production manifests and build artifacts
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/
COPY --from=build /app/apps/server/dist ./apps/server/dist

# Install production-only dependencies
RUN pnpm --filter @voice-assistant/server install --prod --frozen-lockfile

# Run as non-root user for security
USER node

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget --spider -q http://localhost:8080/health || exit 1

CMD ["node", "apps/server/dist/index.js"]
