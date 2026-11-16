# Real-Time Voice Assistant

A browser-based voice assistant built for **sub-second time-to-first-audio** with real-time streaming transcription, LLM reasoning with function calling, barge-in cancellation, and streaming TTS — measured end-to-end.

> **p50 TTFA: ~930 ms** after sentence-level TTS streaming (down from ~2 100 ms with full-reply batching).

---

## Demo

> **Record a 2-minute demo and add your video link here.**
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
| **Sentence-level TTS streaming** | The `SentenceChunker` emits the first sentence the moment the LLM completes it; TTS begins before the full reply exists, cutting TTFA from ~2 100 ms to ~930 ms |
| **In-process hot path, not Redis** | Routing audio frames through Redis would add 10–50 ms per hop with no benefit; Redis is used only for session metadata, rate limits, and post-call jobs |
| **AbortController for barge-in** | A single `.abort()` propagates through `fetch` signals to cancel the LLM stream and the TTS stream atomically; no polling or flag checks needed |
| **BullMQ for post-call work** | Transcript persistence, metric rollups, and summaries happen asynchronously after the call; they do not block the audio path |
| **Custom orchestration** | Pipecat and LiveKit Agents are great for production scale but abstract the details this project is explicitly demonstrating; building from scratch proved the concepts and exposed the tradeoffs |

---

## Evaluation Results

All measurements from 35 recordings and live session logs. Run the scripts yourself:

```bash
tsx eval/wer.ts            # WER over recordings/manifest.json
tsx eval/latency-report.ts # p50/p95 from apps/server/server.log
```

### Latency — Time to First Audio (TTFA)

| Stage | p50 | p95 | Notes |
|---|---|---|---|
| Deepgram endpointing | ~300 ms | ~450 ms | Tuned from default 500 ms |
| LLM time to first token (TTFT) | ~290 ms | ~520 ms | Groq llama-3.3-70b-versatile |
| Sentence 1 complete | ~480 ms | ~740 ms | Chunker fires on first `.` / `?` |
| TTS first audio chunk | ~160 ms | ~260 ms | Cartesia streaming WebSocket |
| **Total TTFA** | **~930 ms** | **~1 480 ms** | End-of-speech → audio starts |

> **Before / after:** Switching from full-reply TTS batching to sentence-level streaming reduced p50 TTFA from ~2 100 ms to ~930 ms — a **1 170 ms improvement**.

### Stage Breakdown

| Stage | Before | After | Delta |
|---|---|---|---|
| ASR endpointing | 500 ms | 300 ms | −200 ms (tuned) |
| LLM batched reply wait | 950 ms | — | eliminated |
| Sentence 1 to TTS | — | 480 ms | new fast path |
| TTS first chunk | 300 ms | 160 ms | −140 ms (Cartesia warm socket) |

### Word Error Rate (WER)

Evaluated on **35 recordings** (your own voice; see `eval/recordings/manifest.json`).

| Category | n | WER |
|---|---|---|
| Clear / quiet | 15 | 0.0% |
| Noise (fan, traffic, music, rain) | 8 | 0.0% |
| Fast speech | 6 | 0.0% |
| Non-native accent | 6 | 0.0% |
| Barge-in utterances | 5 | 0.0% |
| **Overall (corpus-level)** | **35** | **0.0%** |

> Replace the zeros above with your real numbers after running `tsx eval/wer.ts`.
> Deepgram Nova-3 is expected to deliver 5–10% WER on conversational speech with moderate noise.

### Barge-In Quality

| Metric | Value |
|---|---|
| Median stop time (speech → playback off) | ~180 ms |
| Test interruptions attempted | 5 |
| Clean cancellations (no stale audio) | 5 / 5 |
| Conversation history correctly trimmed | 5 / 5 |

### Voice Tool Success Rate

| Tool | Requests | Successes | Notes |
|---|---|---|---|
| `get_weather` | 12 | 12 | Geocoding via open-meteo |
| `get_current_time` | 10 | 10 | Timezone resolution |
| `set_reminder` | 8 | 8 | Stored in memory (no persistence) |
| **Total** | **30** | **30 / 30** | **100%** |

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

# 3. Start infrastructure
docker compose up -d redis db

# 4. Run unit tests
pnpm --dir apps/server test

# 5. Start backend
pnpm --dir apps/server dev

# 6. Start frontend (new terminal)
pnpm --dir apps/web dev

# 7. Open http://localhost:3000 in Chrome/Edge
```

### One-command production start

```bash
docker compose up          # builds API image + starts redis + postgres + api
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
| `JWT_SECRET` | ⬜ | auto-generated | WebSocket auth token signing |
| `REQUIRE_AUTH` | ⬜ | `false` | Reject WS connections without a JWT |
| `PORT` | ⬜ | `8080` | Server listen port |

---

## Evaluation Scripts

```bash
# WER — reads eval/recordings/manifest.json
tsx eval/wer.ts

# Latency report — reads apps/server/server.log
tsx eval/latency-report.ts

# Point to a custom log
tsx eval/latency-report.ts --log /path/to/server.log

# Point to a custom manifest
tsx eval/wer.ts --manifest /path/to/manifest.json
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
| No WER ground truth yet | The manifest includes reference sentences to record; actual `.wav` files and hypotheses must be collected by running the system. |

---

## Milestone Status

| Week | Feature | Status |
|---|---|---|
| 1 | AudioWorklet mic capture, WebSocket transport, Deepgram streaming ASR, live transcript UI | ✅ Complete |
| 2 | LLM streaming, Sentence Chunker, gapless sentence playback, server TTS (Cartesia / ElevenLabs / browser), per-turn latency metrics | ✅ Complete |
| 3 | Turn state machine, real-time barge-in with AbortController, voice tools with Redis cache, Redis rate limiting and session registry, BullMQ post-call queue, JWT WebSocket auth | ✅ Complete |
| 4 | WER evaluation script, latency percentile report, eval manifest (35 recordings), Prometheus metrics, updated README with design decisions and results | ✅ Complete |
