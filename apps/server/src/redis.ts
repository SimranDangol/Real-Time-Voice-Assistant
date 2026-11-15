import { Redis } from "ioredis";
import { logger } from "./logger.js";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

let redisClient: Redis | null = null;
let isRedisAvailable = false;

try {
  redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      if (times > 3) {
        logger.warn("Redis unreachable, falling back to in-memory mode");
        return null; // stop retrying
      }
      return Math.min(times * 100, 2000);
    },
    lazyConnect: false,
  });

  redisClient.on("connect", () => {
    isRedisAvailable = true;
    logger.info("Connected to Redis");
  });

  redisClient.on("error", (err) => {
    if (isRedisAvailable) {
      logger.warn({ err: err.message }, "Redis connection error");
    }
    isRedisAvailable = false;
  });
} catch (err) {
  logger.warn({ err }, "Failed to initialize Redis client; running with in-memory fallback");
}

export function getRedis(): Redis | null {
  return isRedisAvailable ? redisClient : null;
}

// ── In-Memory Fallbacks for Local Dev ──────────────────────────────────────────
const inMemorySessions = new Map<string, { ip: string; startedAt: number; lastHeartbeat: number }>();
const inMemoryRateLimits = new Map<string, { count: number; expiresAt: number }>();
const inMemoryCache = new Map<string, { val: string; expiresAt: number }>();

// ── Session Registry ──────────────────────────────────────────────────────────
export async function registerSession(
  sessionId: string,
  ip: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const client = getRedis();
  const sessionData = {
    ip,
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
    instanceId: process.pid.toString(),
    ...metadata,
  };

  if (client) {
    try {
      await client.set(`session:${sessionId}`, JSON.stringify(sessionData), "EX", 3600); // 1 hour TTL
      await client.sadd("active_sessions", sessionId);
      return;
    } catch (err) {
      logger.warn({ err, sessionId }, "Redis error registering session, using in-memory");
    }
  }

  inMemorySessions.set(sessionId, {
    ip,
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
  });
}

export async function updateSessionHeartbeat(sessionId: string): Promise<void> {
  const client = getRedis();
  if (client) {
    try {
      const data = await client.get(`session:${sessionId}`);
      if (data) {
        const parsed = JSON.parse(data);
        parsed.lastHeartbeat = Date.now();
        await client.set(`session:${sessionId}`, JSON.stringify(parsed), "EX", 3600);
      }
      return;
    } catch {
      // ignore
    }
  }

  const mem = inMemorySessions.get(sessionId);
  if (mem) {
    mem.lastHeartbeat = Date.now();
  }
}

export async function unregisterSession(sessionId: string): Promise<void> {
  const client = getRedis();
  if (client) {
    try {
      await client.del(`session:${sessionId}`);
      await client.srem("active_sessions", sessionId);
      return;
    } catch (err) {
      logger.warn({ err, sessionId }, "Redis error unregistering session");
    }
  }

  inMemorySessions.delete(sessionId);
}

// ── Rate Limiting ─────────────────────────────────────────────────────────────
/**
 * Sliding window / fixed window rate limiter.
 * Returns { allowed: boolean, remaining: number, resetSeconds: number }
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number }> {
  const client = getRedis();
  const redisKey = `ratelimit:${key}`;

  if (client) {
    try {
      const current = await client.incr(redisKey);
      if (current === 1) {
        await client.expire(redisKey, windowSeconds);
      }
      const allowed = current <= limit;
      return { allowed, remaining: Math.max(0, limit - current) };
    } catch (err) {
      logger.warn({ err, key }, "Redis rate-limit error, allowing request");
      return { allowed: true, remaining: limit };
    }
  }

  // In-memory fallback
  const now = Date.now();
  const entry = inMemoryRateLimits.get(key);
  if (!entry || entry.expiresAt < now) {
    inMemoryRateLimits.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });
    return { allowed: true, remaining: limit - 1 };
  }

  entry.count += 1;
  const allowed = entry.count <= limit;
  return { allowed, remaining: Math.max(0, limit - entry.count) };
}

// ── Short-Lived Tool Result Cache ─────────────────────────────────────────────
export async function getCachedToolResult(key: string): Promise<string | null> {
  const client = getRedis();
  const redisKey = `cache:tool:${key}`;

  if (client) {
    try {
      return await client.get(redisKey);
    } catch {
      return null;
    }
  }

  const now = Date.now();
  const entry = inMemoryCache.get(key);
  if (entry && entry.expiresAt > now) {
    return entry.val;
  }
  return null;
}

export async function setCachedToolResult(
  key: string,
  value: string,
  ttlSeconds = 120
): Promise<void> {
  const client = getRedis();
  const redisKey = `cache:tool:${key}`;

  if (client) {
    try {
      await client.set(redisKey, value, "EX", ttlSeconds);
      return;
    } catch {
      // ignore
    }
  }

  inMemoryCache.set(key, { val: value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch {
      redisClient.disconnect();
    }
    redisClient = null;
    isRedisAvailable = false;
  }
}

