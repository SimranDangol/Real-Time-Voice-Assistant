import { PrismaClient } from "@prisma/client";
import { logger } from "./logger.js";

export interface PersistedTurn {
  turnId: string;
  userText?: string;
  assistantText?: string;
  ttfaMs?: number | null;
  llmFirstTokenMs?: number | null;
  sentence1Ms?: number | null;
  totalLlmMs?: number | null;
  interrupted?: boolean;
}

export interface PersistedSession {
  sessionId: string;
  ip: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  turns: PersistedTurn[];
}

let prisma: PrismaClient | null = null;
let retentionTimer: NodeJS.Timeout | null = null;

function getRetentionDays(): number {
  const days = Number(process.env.DATA_RETENTION_DAYS ?? "30");
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error("DATA_RETENTION_DAYS must be an integer between 1 and 3650");
  }
  return days;
}

export async function connectDatabase(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("DATABASE_URL is required in production");
    }
    logger.warn("DATABASE_URL is unset; Postgres persistence is disabled");
    return;
  }

  const client = new PrismaClient();
  try {
    await client.$connect();
    prisma = client;
    logger.info("Connected to Postgres");
  } catch (error) {
    await client.$disconnect();
    throw error;
  }
}

export async function persistSession(data: PersistedSession): Promise<void> {
  if (!prisma) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Cannot persist session because Postgres is not connected");
    }
    logger.warn({ sessionId: data.sessionId }, "Skipping session persistence without DATABASE_URL");
    return;
  }

  const transcriptRows = data.turns.flatMap((turn) => {
    const rows: Array<{
      sessionId: string;
      turnId: string;
      role: string;
      content: string;
      interrupted: boolean;
    }> = [];
    if (turn.userText?.trim()) {
      rows.push({
        sessionId: data.sessionId,
        turnId: turn.turnId,
        role: "user",
        content: turn.userText,
        interrupted: false,
      });
    }
    if (turn.assistantText?.trim()) {
      rows.push({
        sessionId: data.sessionId,
        turnId: turn.turnId,
        role: "assistant",
        content: turn.assistantText,
        interrupted: turn.interrupted ?? false,
      });
    }
    return rows;
  });

  const metricRows = data.turns.map((turn) => ({
    sessionId: data.sessionId,
    turnId: turn.turnId,
    ttfaMs: turn.ttfaMs ?? null,
    llmFirstTokenMs: turn.llmFirstTokenMs ?? null,
    sentence1Ms: turn.sentence1Ms ?? null,
    totalLlmMs: turn.totalLlmMs ?? null,
    interrupted: turn.interrupted ?? false,
  }));

  await prisma.$transaction(async (transaction) => {
    await transaction.session.upsert({
      where: { id: data.sessionId },
      create: {
        id: data.sessionId,
        ip: data.ip,
        startedAt: new Date(data.startedAtMs),
        endedAt: new Date(data.endedAtMs),
        durationMs: data.durationMs,
      },
      update: {
        ip: data.ip,
        startedAt: new Date(data.startedAtMs),
        endedAt: new Date(data.endedAtMs),
        durationMs: data.durationMs,
      },
    });

    await transaction.transcript.deleteMany({ where: { sessionId: data.sessionId } });
    if (transcriptRows.length > 0) {
      await transaction.transcript.createMany({ data: transcriptRows });
    }

    await transaction.turnMetric.deleteMany({ where: { sessionId: data.sessionId } });
    if (metricRows.length > 0) {
      await transaction.turnMetric.createMany({ data: metricRows });
    }
  });
}

export async function purgeExpiredSessions(): Promise<number> {
  if (!prisma) return 0;
  const retentionDays = getRetentionDays();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await prisma.session.deleteMany({
    where: { endedAt: { not: null, lt: cutoff } },
  });
  if (result.count > 0) {
    logger.info({ deletedSessions: result.count, retentionDays }, "Purged expired session data");
  }
  return result.count;
}

export async function startRetentionCleanup(): Promise<void> {
  if (!prisma) return;
  getRetentionDays();
  await purgeExpiredSessions();
  retentionTimer = setInterval(() => {
    void purgeExpiredSessions().catch((error) => {
      logger.error({ err: error }, "Failed to purge expired session data");
    });
  }, 24 * 60 * 60 * 1000);
  retentionTimer.unref();
}

export async function closeDatabase(): Promise<void> {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
  if (prisma) {
    const client = prisma;
    prisma = null;
    await client.$disconnect();
  }
}
