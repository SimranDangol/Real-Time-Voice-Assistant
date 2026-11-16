# Real-Time Voice Assistant

A browser-based voice assistant targeting **sub-second time-to-first-audio** with real-time streaming transcription, LLM reasoning with function calling, barge-in cancellation, and streaming TTS.

> **Performance results are not currently verified.** Run the live evaluation procedures below and record real sessions before publishing latency or WER claims.

---

## Demo

> **Demo video not yet provided.** Record a 2-minute demo and add its link here.
>
> Suggested scenes: (1) normal Q&A with weather tool, (2) barge-in mid-sentence, (3) reminder tool, (4) latency dashboard visible.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser (Next.js + AudioWorklet)                                   │
│  Mic → 16kHz PCM-16 binary frames ──────────────────────────────┐  │
│  Audio queue ← binary PCM chunks ←─────────────────────────────┐│  │
│  Transcript UI ← JSON events ←────────────────────────────────┐││  │
└───────────────────────────────────────────────────────────────│││──┘
                WebSocket (/ws?token=...)                        │││
┌───────────────────────────────────────────────────────────────│││──┐
│  Express + ws Server                                          │││  │
│                                                               │││  │
│  JWT auth ──► Session State Machine                           │││  │
│               idle→listening→thinking→speaking→idle           │││  │
│                                ▼ (barge-in: abort + flush)   │││  │
│  Deepgram Nova-3 ASR (streaming, endpointing 300ms) ──────────┘││  │
│               ▼ final transcript                               ││  │
│  LLM Streaming (Groq / OpenAI) ◄──► Voice Tools               ││  │
│               │                     (weather/time/reminder)   ││  │
│               ▼ token deltas        ◄─ Redis cache (120s TTL) ││  │
│  Sentence Chunker                                              ││  │
│               ▼ sentence 1 → TTS immediately                  ││  │
│  Cartesia / ElevenLabs streaming TTS ─────────────────────────┘│  │
│               ▼ PCM audio chunks ──────────────────────────────┘  │
│                                                                     │
│  Redis: rate limits, session registry, BullMQ queue                │
│  Postgres: users, sessions, transcripts, per-turn metrics           │
│  Prometheus: TTFA / TTFT / sentence latency histograms             │
└─────────────────────────────────────────────────────────────────────┘
```

### Turn State Machine

```
   idle ──► listening ──► thinking ──► speaking ──► idle
              ▲               │             │
              └───────────────┴─ barge-in ──┘
                     (AbortController cancels LLM + TTS,
                      client buffer flushed, history trimmed)
```

---

## Why these design decisions?

| Decision | Rationale |
|---|---|
| **TypeScript end-to-end** | Shared types between browser and server (`packages/shared`); single language reduces context-switching |
| **Deepgram Nova-3** over Whisper | True streaming with partial transcripts and configurable endpointing; Whisper requires a full utterance before transcribing — adds 400–800 ms |
| **Sentence-level TTS streaming** | The `SentenceChunker` emits the first sentence as soon as it is complete, allowing TTS to start before the full reply; live latency results still need to be measured |
| **In-process hot path, not Redis** | Routing audio frames through Redis would add 10–50 ms per hop with no benefit; Redis is used only for session metadata, rate limits, and post-call jobs |
| **AbortController for barge-in** | A single `.abort()` propagates through `fetch` signals to cancel the LLM stream and the TTS stream atomically; no polling or flag checks needed |
| **BullMQ for post-call work** | Transcript persistence, metric rollups, and summaries happen asynchronously after the call; they do not block the audio path |
| **Custom orchestration** | Pipecat and LiveKit Agents are great for production scale but abstract the details this project is explicitly demonstrating; building from scratch proved the concepts and exposed the tradeoffs |

---

## Evaluation Status

The evaluation tools are available, but the prior published measurements are not evidence of live performance: the audio generator creates synthetic tones rather than speech, and the latency-log generator creates randomized sample metrics. The generators now write only to `eval/fixtures/`; their output must not be used as real WER or latency results. Existing WAVs and logs should be replaced or confirmed as genuine before publishing measurements.

The default WER command compares manifest text hypotheses and checks WAV file format; it does not run ASR or prove that a WAV contains speech. For a live ASR measurement, use genuine microphone recordings and provide `DEEPGRAM_API_KEY` through the process environment:

```bash
pnpm --dir eval wer
pnpm --dir eval wer:live
```

For latency, run real conversations with the server and report only from the resulting server log. To compare sentence streaming with buffered TTS, set `TTS_STREAMING_MODE=buffered` and a distinct `LOG_FILE_PATH` for the baseline run, then use `TTS_STREAMING_MODE=sentence` and a different log path for the streaming run:

```bash
pnpm --dir eval latency -- --log path/to/streaming.log --compare path/to/buffered.log
```

The demo video, live WER results, and comparable before/after latency measurements remain pending real recordings and sessions.

---

## Voice Tools

| Tool | Example phrase | Cached |
|---|---|---|
| `get_weather` | "What's the weather in Pokhara?" | Redis 120 s TTL |
| `get_current_time` | "What time is it in London?" | No |
| `set_reminder` | "Remind me to buy groceries at 6 PM" | No |

---

## Redis & BullMQ

| Use | Detail |
|---|---|
| Session registry | Live sessions tracked with heartbeat + TTL |
| Rate limiting | IP-based sliding window on session starts |
| Tool result cache | Short-lived (120 s) results for `get_weather` |
| BullMQ queue | Post-call: avg TTFA, turn count, interrupted turns |
| **Not used for** | Audio frames, partial transcripts, LLM tokens |

> Interview point: a WebSocket session is pinned to one process. Scaling out requires sticky routing (e.g. nginx `ip_hash`) or a session registry. This project demonstrates the registry; sticky routing is left for production.

---

## Prometheus Metrics

Exposed at `GET /metrics` (Prometheus format):

| Metric | Type | Description |
|---|---|---|
| `voice_assistant_ttfa_ms` | Histogram | Time-to-first-audio per turn |
| `voice_assistant_llm_ttft_ms` | Histogram | LLM time-to-first-token |
| `voice_assistant_sentence1_ms` | Histogram | Time until first sentence complete |
| `voice_assistant_active_sessions` | Gauge | Live WebSocket sessions |
| `voice_assistant_interrupted_turns_total` | Counter | Barge-in interruptions |

---

## Project Structure

```
Real-Time-Voice-Assistant/
├── apps/
│   ├── web/                      Next.js client
│   │   ├── src/app/page.tsx      UI with state machine indicators
│   │   ├── src/components/       TranscriptView (tool bubbles, barge-in marks)
│   │   └── src/hooks/useMic.ts   AudioWorklet, WebSocket, PCM playback
│   └── server/
│       ├── src/
│       │   ├── index.ts          Express bootstrap, JWT endpoint, /metrics
│       │   ├── auth.ts           Short-lived JWT issue/verify
│       │   ├── redis.ts          Session registry, rate limiting, tool cache
│       │   ├── queue.ts          BullMQ post-call summary producer + worker
│       │   ├── metrics.ts        Prometheus histograms, TurnTimer
│       │   ├── ws/
│       │   │   ├── session.ts    Turn state machine, barge-in, teardown
│       │   │   └── protocol.ts   Zod schemas for all WebSocket messages
│       │   ├── providers/
│       │   │   ├── asr.deepgram.ts   Deepgram streaming ASR
│       │   │   ├── llm.ts            Streaming LLM with function calling
│       │   │   ├── tts.cartesia.ts   Cartesia streaming TTS
│       │   │   └── tts.elevenlabs.ts ElevenLabs streaming TTS
│       │   ├── pipeline/
│       │   │   ├── chunker.ts    Sentence boundary detection for early TTS
│       │   │   └── bargein.ts    Turn manager, AbortController, history trim
│       │   └── tools/
│       │       └── index.ts      get_weather, get_current_time, set_reminder
│       ├── prisma/schema.prisma  Users, sessions, transcripts, turn metrics
│       └── src/__tests__/        Unit tests (barge-in, JWT, tools, Redis, Prometheus)
├── eval/
│   ├── wer.ts                    WER evaluation script (Levenshtein, tag breakdown)
│   ├── latency-report.ts         p50/p95 latency report from server.log
│   └── recordings/
│       ├── manifest.json         35 entries: file, reference, hypothesis, tags
│       └── README.md             Recording procedure and tag definitions
├── .github/workflows/ci.yml      Lint, typecheck, test, build image
├── docker-compose.yml            API + Redis + Postgres with healthchecks
├── Dockerfile                    Multi-stage production image
└── README.md
```

---

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env
# Edit .env — required keys:
#   DEEPGRAM_API_KEY    — deepgram.com (free $200 credit, no card)
#   GROQ_API_KEY        — console.groq.com (free tier, fast TTFT)
#   REDIS_URL           — redis://localhost:6379 (provided by Docker)
# Optional:
#   CARTESIA_API_KEY    — cartesia.ai (streaming TTS)
#   ELEVENLABS_API_KEY  — elevenlabs.io (streaming TTS)
#   TTS_PROVIDER        — "browser" (default), "cartesia", or "elevenlabs"
#   DATABASE_URL        — Postgres (required for production persistence)
#   SENTRY_DSN          — optional error reporting

# 3. Start infrastructure
docker compose up -d redis db

# 4. Apply database migrations
pnpm --dir apps/server db:deploy

# 5. Run unit tests
pnpm --dir apps/server test

# 6. Start backend
pnpm --dir apps/server dev

# 7. Start frontend (new terminal)
pnpm --dir apps/web dev

# 8. Open http://localhost:3000 in Chrome/Edge
```

### One-command production start

```bash
docker compose up          # builds API image, applies migrations, starts redis + postgres + api
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DEEPGRAM_API_KEY` | ✅ | — | Deepgram streaming ASR |
| `GROQ_API_KEY` | ✅* | — | LLM (*or* `OPENAI_API_KEY`) |
| `OPENAI_API_KEY` | ✅* | — | LLM (*or* `GROQ_API_KEY`) |
| `CARTESIA_API_KEY` | ⬜ | — | Streaming TTS (Cartesia) |
| `ELEVENLABS_API_KEY` | ⬜ | — | Streaming TTS (ElevenLabs) |
| `TTS_PROVIDER` | ⬜ | `browser` | `browser` / `cartesia` / `elevenlabs` |
| `REDIS_URL` | ⬜ | `redis://localhost:6379` | Redis connection |
| `DATABASE_URL` | ⬜ | — | Postgres (Prisma) |
| `POSTGRES_PASSWORD` | ⬜ | Compose dev default | Postgres password; set a strong secret for deployment |
| `DATA_RETENTION_DAYS` | ⬜ | `30` | Days to retain completed sessions, transcripts, and turn metrics (1–3650) |
| `SENTRY_DSN` | ⬜ | — | Optional Sentry error reporting; request data is scrubbed |
| `ASR_CONNECT_TIMEOUT_MS` | ⬜ | `10000` | Deepgram WebSocket connection timeout |
| `LLM_REQUEST_TIMEOUT_MS` | ⬜ | `30000` | LLM request timeout |
| `TOOL_REQUEST_TIMEOUT_MS` | ⬜ | `10000` | External tool request timeout |
| `TTS_CONNECT_TIMEOUT_MS` | ⬜ | `10000` | TTS WebSocket connection timeout |
| `TTS_RESPONSE_TIMEOUT_MS` | ⬜ | `15000` | TTS response timeout |
| `TTS_STREAMING_MODE` | ⬜ | `sentence` | `sentence` for streaming; `buffered` for latency baseline runs |
| `JWT_SECRET` | ⬜ | auto-generated | WebSocket auth token signing |
| `REQUIRE_AUTH` | ⬜ | `false` | Reject WS connections without a JWT |
| `PORT` | ⬜ | `8080` | Server listen port |
| `LOG_FILE_PATH` | ⬜ | `apps/server/server.log` | Structured JSON log destination for latency reports |

In production, `DATABASE_URL` is required. Completed sessions, transcripts, and turn metrics are persisted after disconnect; retention cleanup runs at startup and daily, with a 30-day default controlled by `DATA_RETENTION_DAYS`. The API container applies Prisma migrations before starting. Application logs omit transcript text and tool arguments. Sentry is optional and its request data is scrubbed.

---

## Evaluation Scripts

```bash
# 1. Manifest WER and WAV format checks (does not verify speech content)
pnpm --dir eval wer
# or: tsx eval/wer.ts

# 2. Live ASR evaluation (requires genuine speech WAVs and DEEPGRAM_API_KEY in process env)
pnpm --dir eval wer:live
# Optionally save fresh live hypotheses:
pnpm --dir eval wer:live -- --save

# 3. Latency report — computes p50/p75/p95 percentiles from apps/server/server.log
pnpm --dir eval latency
# or: tsx eval/latency-report.ts

# Optional: Point to custom log or manifest files
tsx eval/latency-report.ts --log /path/to/server.log
tsx eval/wer.ts --manifest /path/to/manifest.json

# Synthetic parser fixtures only (not real recordings or performance data)
pnpm --dir eval generate:synthetic-audio
pnpm --dir eval generate:latency-fixture
```

---

## Limitations

| Limitation | Detail |
|---|---|
| Single-instance sessions | WebSocket sessions are pinned to one process; scaling out needs sticky routing or the session registry. |
| In-memory reminders | `set_reminder` stores reminders in process memory; they do not persist across restarts or trigger notifications. |
| Weather tool | Uses [Open-Meteo](https://open-meteo.com/) geocoding; city name matching may fail for small or ambiguous city names. |
| Demo-level auth | JWT tokens are short-lived but there is no user account system; anyone with the server URL can connect. |
| Browser TTS quality | The fallback `speechSynthesis` voice varies by OS and browser; use Cartesia or ElevenLabs for demos. |

---

## Milestone Status

| Week | Feature | Status |
|---|---|---|
| 1 | AudioWorklet mic capture, WebSocket transport, Deepgram streaming ASR, live transcript UI | ✅ Complete |
| 2 | LLM streaming, Sentence Chunker, gapless sentence playback, server TTS (Cartesia / ElevenLabs / browser), per-turn latency metrics | ✅ Complete |
| 3 | Turn state machine, real-time barge-in with AbortController, voice tools with Redis cache, Redis rate limiting and session registry, BullMQ post-call queue, JWT WebSocket auth | ✅ Complete |
| 4 | Evaluation tooling and Prometheus metrics implemented; real recordings, live measurements, and demo evidence still pending | ⚠️ Partially verified |
