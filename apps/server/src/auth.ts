import jwt from "jsonwebtoken";
import { logger } from "./logger.js";

const JWT_SECRET = process.env.JWT_SECRET || "voice-assistant-dev-secret-key-32chars!";
const TOKEN_EXPIRY_SECONDS = 600; // 10 minutes

export interface TokenPayload {
  sessionId: string;
  ip: string;
  iat?: number;
  exp?: number;
}

/**
 * Issues a short-lived JWT token for authenticating a WebSocket session.
 */
export function issueToken(sessionId: string, ip: string): { token: string; expiresIn: number } {
  const token = jwt.sign({ sessionId, ip }, JWT_SECRET, {
    expiresIn: TOKEN_EXPIRY_SECONDS,
  });

  return {
    token,
    expiresIn: TOKEN_EXPIRY_SECONDS,
  };
}

/**
 * Verifies a WebSocket upgrade JWT token.
 */
export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as TokenPayload;
    return decoded;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "JWT verification failed");
    return null;
  }
}
