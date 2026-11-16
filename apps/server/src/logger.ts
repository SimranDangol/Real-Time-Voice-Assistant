import pino from "pino";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logFilePath = process.env.LOG_FILE_PATH || path.resolve(__dirname, "../server.log");

// Ensure log file directory exists
const logDir = path.dirname(logFilePath);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Write structured logs for latency reports and operational diagnostics.
const fileStream = fs.createWriteStream(logFilePath, { flags: "a" });

// Pretty console logging in development, raw stream in production
const consoleTransport =
  process.env.NODE_ENV !== "production"
    ? pino.transport({
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
      })
    : process.stdout;

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
  },
  pino.multistream([
    { stream: consoleTransport, level: "info" },
    { stream: fileStream, level: "info" },
  ])
);
