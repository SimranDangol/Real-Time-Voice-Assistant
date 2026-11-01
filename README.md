# Real-Time Voice Assistant

A browser-based voice assistant built for low-latency streaming transcription, reasoning, and voice conversation flow.

## Architecture

- `apps/web`: Next.js client with `AudioWorklet` microphone capture, sequential sentence playback queue, and latency dashboard.
- `apps/server`: Node.js + Express WebSocket session manager with streaming Deepgram Nova-3 ASR, Sentence Chunker, and streaming LLM integration.
- `docker-compose.yml`: Redis and Postgres services for persistence and background worker queue.

## Pipeline Flow

```
[User Mic] 
   ↓ (16kHz PCM-16 over WebSocket)
[Fastify/Express Server] 
   ↓ (Binary frame relay)
[Deepgram Nova-3 ASR] 
   ↓ (Final transcript)
[LLM Streaming (Groq / OpenAI)] 
   ↓ (Token deltas)
[Sentence Chunker] 
   ↓ (Sentence 1 emitted immediately)
[Audio Queue / Web Speech / Streaming TTS] 
   ↓ (Spoken reply starts before full LLM response finishes)
[Latency Timer Logs (TTFA ~1s)]
```

## Local Development

1. **Install dependencies:**
   ```bash
   pnpm install
   ```

2. **Configure environment variables:**
   Copy `.env.example` to `.env` and provide your keys:
   - `DEEPGRAM_API_KEY`: Required for live speech-to-text.
   - `GROQ_API_KEY` or `OPENAI_API_KEY`: Required for LLM replies. (Groq recommended for ~150-250ms TTFT).

3. **Start the backend:**
   ```bash
   cd apps/server
   pnpm dev
   ```

4. **Start the frontend:**
   ```bash
   cd apps/web
   pnpm dev
   ```

5. Open `http://localhost:3000` in Chrome/Edge, click **Start**, and talk to the assistant.

## Milestone Status

- **Week 1 (Complete):** AudioWorklet mic capture, WebSocket transport, Deepgram streaming ASR, live transcription UI.
- **Week 2 (Complete):** LLM streaming, Sentence Chunker (`apps/server/src/pipeline/chunker.ts`), gapless sequential sentence playback, and per-turn latency metrics (TTFA, TTFT, Sentence 1).
- **Week 3 (Upcoming):** End-of-turn tuning, barge-in cancellation (`AbortController`), voice tools (weather, reminders), BullMQ post-call jobs.
- **Week 4 (Upcoming):** Word Error Rate (WER) evaluations, latency benchmark report (p50/p95).
