import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";


dotenv.config();
dotenv.config({ path: path.resolve(fileURLToPath(import.meta.url), "../../../../.env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

import express from "express";
import cors from "cors";
import http from "node:http";
import { WebSocketServer } from "ws";
import { handleSession } from "./ws/session.js";
import { logger } from "./logger.js";

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── REST routes ───────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket, req) => {
  const sessionId = crypto.randomUUID();
  const ip = req.socket.remoteAddress ?? "unknown";
  handleSession(socket, sessionId, ip);
});

// ── Start ─────────────────────────────────────────────────────────────────────
const port = Number(process.env.PORT ?? 8080);

server.listen(port, () => {
  logger.info(`Server listening on http://localhost:${port}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    logger.info(`${signal} received — shutting down`);
    wss.close();
    server.close(() => process.exit(0));
  });
}
