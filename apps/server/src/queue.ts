import { Queue, Worker, type Job } from "bullmq";
import { getRedis } from "./redis.js";
import { logger } from "./logger.js";

export interface TurnSummary {
  turnId: string;
  userText?: string;
  assistantText?: string;
  ttfaMs?: number | null;
  llmFirstTokenMs?: number | null;
  sentence1Ms?: number | null;
  interrupted?: boolean;
}

export interface PostCallJobData {
  sessionId: string;
  ip: string;
  durationMs: number;
  turnCount: number;
  turns: TurnSummary[];
}

const QUEUE_NAME = "post-call-summary";
let postCallQueue: Queue<PostCallJobData> | null = null;
let postCallWorker: Worker<PostCallJobData> | null = null;

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

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
        const { sessionId, durationMs, turnCount, turns } = job.data;
        
        // Calculate metrics rollups
        const validTtfas = turns
          .map((t) => t.ttfaMs)
          .filter((t): t is number => typeof t === "number" && t > 0);

        const avgTtfa = validTtfas.length
          ? Math.round(validTtfas.reduce((a, b) => a + b, 0) / validTtfas.length)
          : null;
        const minTtfa = validTtfas.length ? Math.min(...validTtfas) : null;
        const maxTtfa = validTtfas.length ? Math.max(...validTtfas) : null;
        const interruptedTurns = turns.filter((t) => t.interrupted).length;

        logger.info(
          {
            jobId: job.id,
            sessionId,
            durationSeconds: Math.round(durationMs / 1000),
            turnCount,
            interruptedTurns,
            metrics: { avgTtfa, minTtfa, maxTtfa },
          },
          "Processed post-call summary job"
        );

        return {
          processedAt: new Date().toISOString(),
          avgTtfa,
          interruptedTurns,
        };
      },
      { connection }
    );

    postCallWorker.on("failed", (job, err) => {
      logger.error({ jobId: job?.id, err }, "Post-call summary job failed");
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

  // Fallback inline computation
  const validTtfas = data.turns
    .map((t) => t.ttfaMs)
    .filter((t): t is number => typeof t === "number" && t > 0);
  const avgTtfa = validTtfas.length
    ? Math.round(validTtfas.reduce((a, b) => a + b, 0) / validTtfas.length)
    : null;

  logger.info(
    {
      sessionId: data.sessionId,
      durationSeconds: Math.round(data.durationMs / 1000),
      turnCount: data.turnCount,
      avgTtfa,
    },
    "[Inline Fallback] Call finished & metrics computed"
  );
}

export async function closeQueue(): Promise<void> {
  if (postCallWorker) {
    await postCallWorker.close();
  }
  if (postCallQueue) {
    await postCallQueue.close();
  }
}
