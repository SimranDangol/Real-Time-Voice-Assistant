# Real-Time Voice Assistant

A browser-based voice assistant built for low-latency streaming transcription, reasoning, tool execution, and voice conversation flow.

## Architecture

- `apps/web`: Next.js client with `AudioWorklet` microphone capture, state machine indicators, sequential sentence playback queue, instant barge-in playback buffer flush, and latency dashboard.
- `apps/server`: Node.js + Express WebSocket session manager with streaming Deepgram Nova-3 ASR, Sentence Chunker, streaming LLM integration with function calling, Redis session registry and rate limiter, and BullMQ background jobs.
- `docker-compose.yml`: Redis and Postgres services for persistence and background worker queue.

## Pipeline Flow

```
[User Mic] 
   ↓ (16kHz PCM-16 over WebSocket)
[Fastify/Express Server] (WebSocket session + turn state machine)
   ↓ (Binary frame relay)
[Deepgram Nova-3 ASR] (Endpointing 300ms, interim results for real-time barge-in)
   ↓ (Final transcript)
[LLM Streaming (Groq / OpenAI)] ↔ [Voice Tools (Weather, Time, Reminders) + Redis Cache]
   ↓ (Token deltas)
[Sentence Chunker] 
   ↓ (Sentence 1 emitted immediately)
[Audio Queue / Web Speech / Streaming TTS] 
   ↓ (Spoken reply starts before full LLM response finishes)
[Latency Timer Logs (TTFA ~1s)]

⚡ Barge-in:
User speech detected while speaking/thinking → AbortController cancels LLM & TTS streams → 
Interrupted event sent to client → Browser audio buffer flushed → Conversation history trimmed.
```

## Turn State Machine

```
idle -> listening -> thinking -> speaking -> idle
          ^                     |
          +----- barge-in ------+ (speaking/thinking -> listening, cancel LLM + TTS, flush client buffer)
```

## Voice Tools Available

1. **`get_weather`**: Real-time weather and temperature for cities (e.g. "What's the weather in Pokhara?"). Cached in Redis for 120s.
2. **`get_current_time`**: Current time lookup with timezone resolution (e.g. "What time is it in London?").
3. **`set_reminder`**: Voice reminder scheduling (e.g. "Remind me to buy groceries at 6 PM").

## Redis & BullMQ Queue Integration

- **Real-Time Hot Path**: Audio frames and streaming tokens stay in-memory for minimal latency.
- **Session Registry**: Live sessions tracked with heartbeat updates and TTL in Redis.
- **Rate Limiting**: Sliding/fixed-window IP rate limits on session starts.
- **BullMQ Queue (`post-call-summary`)**: On session termination, post-call summary jobs compute average TTFA, turn counts, and interrupted turns asynchronously.
- **JWT Auth**: Short-lived tokens issued via `/api/auth/token` and verified on WebSocket upgrade.

## Local Development

1. **Install dependencies:**
   ```bash
   pnpm install
   ```

2. **Configure environment variables:**
   Copy `.env.example` to `.env` and provide your keys:
   - `DEEPGRAM_API_KEY`: Required for live speech-to-text.
   - `GROQ_API_KEY` or `OPENAI_API_KEY`: Required for LLM replies and tool execution. (Groq recommended for ~150-250ms TTFT).
   - `CARTESIA_API_KEY` or `ELEVENLABS_API_KEY` (optional): enables server-side streaming TTS. Set `TTS_PROVIDER=browser` (or leave keys empty) to use the browser's built-in speech instead.
   - `REDIS_URL`: `redis://localhost:6379` (runs via Docker Compose).

3. **Start infrastructure (optional for Redis & Postgres):**
   ```bash
   docker compose up -d redis
   ```

4. **Run unit tests:**
   ```bash
   pnpm --dir apps/server test
   ```

5. **Start the backend:**
   ```bash
   cd apps/server
   pnpm dev
   ```

6. **Start the frontend:**
   ```bash
   cd apps/web
   pnpm dev
   ```

7. Open `http://localhost:3000` in Chrome/Edge, click **Start**, and talk to the assistant.

## Milestone Status

- **Week 1 (Complete):** AudioWorklet mic capture, WebSocket transport, Deepgram streaming ASR, live transcription UI.
- **Week 2 (Complete):** LLM streaming, Sentence Chunker (`apps/server/src/pipeline/chunker.ts`), gapless sentence playback (server TTS via Cartesia/ElevenLabs WebSocket *or* browser `speechSynthesis` fallback), warm per-session TTS connection, per-turn latency metrics (TTFA, LLM first token, sentence 1, total LLM).
- **Week 3 (Complete):** End-of-turn tuning, real-time barge-in with `AbortController` cancellation & history trimming, voice tools (`get_weather`, `get_current_time`, `set_reminder`) with Redis short-lived caching, Redis session registry and rate limiting, BullMQ post-call summary queue, and short-lived JWT WebSocket authentication.
- **Week 4 (Upcoming):** Word Error Rate (WER) evaluations, latency benchmark report (p50/p95).
