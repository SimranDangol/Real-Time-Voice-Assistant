import { Queue, Worker, type Job } from "bullmq";
import { getRedis } from "./redis.js";
import { logger } from "./logger.js";
import { persistSession, type PersistedSession } from "./db.js";
import { captureError } from "./sentry.js";

export interface TurnSummary {
  turnId: string;
  userText?: string;
  assistantText?: string;
  ttfaMs?: number | null;
  llmFirstTokenMs?: number | null;
  sentence1Ms?: number | null;
  totalLlmMs?: number | null;
  interrupted?: boolean;
}

export interface PostCallJobData extends PersistedSession {
  turnCount: number;
}

const QUEUE_NAME = "post-call-summary";
let postCallQueue: Queue<PostCallJobData> | null = null;
let postCallWorker: Worker<PostCallJobData> | null = null;

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

async function processPostCallSummary(data: PostCallJobData): Promise<void> {
  await persistSession(data);

  const validTtfas = data.turns
    .map((turn) => turn.ttfaMs)
    .filter((ttfa): ttfa is number => typeof ttfa === "number" && ttfa > 0);
  const avgTtfa = validTtfas.length
    ? Math.round(validTtfas.reduce((total, ttfa) => total + ttfa, 0) / validTtfas.length)
    : null;

  logger.info(
    {
      sessionId: data.sessionId,
      durationSeconds: Math.round(data.durationMs / 1000),
      turnCount: data.turnCount,
      avgTtfa,
      interruptedTurns: data.turns.filter((turn) => turn.interrupted).length,
    },
    "Processed post-call summary"
  );
}

export function initQueue(): void {
  try {
    const url = new URL(redisUrl);
    const connection = {
      host: url.hostname || "127.0.0.1",
      port: Number(url.port) || 6379,
      password: url.password || undefined,
      maxRetriesPerRequest: null, // Required by BullMQ
    };

    postCallQueue = new Queue<PostCallJobData>(QUEUE_NAME, { connection });

    postCallWorker = new Worker<PostCallJobData>(
      QUEUE_NAME,
      async (job: Job<PostCallJobData>) => {
        await processPostCallSummary(job.data);
        return { processedAt: new Date().toISOString() };
      },
      { connection }
    );

    postCallWorker.on("failed", (job, err) => {
      logger.error({ jobId: job?.id, err }, "Post-call summary job failed");
      captureError(err, { component: "post-call-queue" });
    });

    logger.info("BullMQ post-call queue initialized");
  } catch (err) {
    logger.warn({ err }, "Could not initialize BullMQ worker/queue, will use in-memory fallback");
  }
}

export async function enqueuePostCallSummary(data: PostCallJobData): Promise<void> {
  if (postCallQueue && getRedis()) {
    try {
      await postCallQueue.add("summarize", data, {
        attempts: 2,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      });
      return;
    } catch (err) {
      logger.warn({ err }, "Failed to push to BullMQ queue, executing inline fallback");
    }
  }

  await processPostCallSummary(data);
}

export async function closeQueue(): Promise<void> {
  if (postCallWorker) {
    await postCallWorker.close();
  }
  if (postCallQueue) {
    await postCallQueue.close();
  }
}
