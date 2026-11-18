import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();
dotenv.config({ path: path.resolve(fileURLToPath(import.meta.url), "../../../../.env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

import express from "express";
import cors from "cors";
import helmet from "helmet";
import http from "node:http";
import { WebSocketServer } from "ws";
import { handleSession } from "./ws/session.js";
import { logger } from "./logger.js";
import { issueToken, verifyToken } from "./auth.js";
import { initQueue, closeQueue } from "./queue.js";
import { closeRedis } from "./redis.js";
import { prometheusRegistry } from "./metrics.js";
import { closeDatabase, connectDatabase, startRetentionCleanup } from "./db.js";
import { captureError, flushErrorReporting, initErrorReporting } from "./sentry.js";
import { getTimeoutMs } from "./providers/request.js";

const app = express();

// ── Security Middleware ──────────────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(",") ?? [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ],
    credentials: true,
  })
);
app.use(express.json());

// ── REST routes ───────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    name: "Real-Time Voice Assistant API",
    status: "online",
    endpoints: {
      health: "/health",
      metrics: "/metrics",
      websocket: "/ws",
    },
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/**
 * Prometheus metrics exporter endpoint.
 */
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", prometheusRegistry.contentType);
  res.end(await prometheusRegistry.metrics());
});

/**
 * Issue a short-lived JWT for WebSocket connection authentication.
 * Prevents unauthorized access or leaking provider keys to browser clients.
 */
app.get("/api/auth/token", (req, res) => {
  const ip = req.socket.remoteAddress ?? "unknown";
  const sessionId = crypto.randomUUID();
  const tokenData = issueToken(sessionId, ip);
  res.json({ ok: true, ...tokenData, sessionId });
});

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket, req) => {
  const ip = req.socket.remoteAddress ?? "unknown";

  // Auth token verification from URL search params: /ws?token=...
  const reqUrl = req.url ? new URL(req.url, "http://localhost") : null;
  const token = reqUrl?.searchParams.get("token");

  let sessionId: string = crypto.randomUUID();

  if (token) {
    const verified = verifyToken(token);
    if (!verified) {
      logger.warn({ ip }, "WebSocket connection rejected: invalid auth token");
      socket.close(1008, "Invalid or expired auth token");
      return;
    }
    sessionId = verified.sessionId;
  } else if (process.env.REQUIRE_AUTH === "true") {
    logger.warn({ ip }, "WebSocket connection rejected: missing auth token");
    socket.close(1008, "Auth token required");
    return;
  }

  handleSession(socket, sessionId, ip);
});

// ── Start ─────────────────────────────────────────────────────────────────────
const port = Number(process.env.PORT ?? 8080);

async function startServer(): Promise<void> {
  initErrorReporting();
  getTimeoutMs("ASR_CONNECT_TIMEOUT_MS", 10_000);
  getTimeoutMs("LLM_REQUEST_TIMEOUT_MS", 30_000);
  getTimeoutMs("TOOL_REQUEST_TIMEOUT_MS", 10_000);
  getTimeoutMs("TTS_CONNECT_TIMEOUT_MS", 10_000);
  getTimeoutMs("TTS_RESPONSE_TIMEOUT_MS", 15_000);
  const ttsStreamingMode = process.env.TTS_STREAMING_MODE ?? "sentence";
  if (ttsStreamingMode !== "sentence" && ttsStreamingMode !== "buffered") {
    throw new Error("TTS_STREAMING_MODE must be 'sentence' or 'buffered'");
  }
  await connectDatabase();
  await startRetentionCleanup();
  initQueue();

  server.listen(port, () => {
    logger.info(`Server listening on http://localhost:${port}`);
  });
}

void startServer().catch((err) => {
  logger.fatal({ err }, "Server startup failed");
  captureError(err, { component: "startup" });
  process.exitCode = 1;
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    logger.info(`${signal} received — shutting down`);
    wss.close();
    await closeQueue();
    await closeRedis();
    await closeDatabase();
    await flushErrorReporting();
    server.close(() => process.exit(0));
  });
}
