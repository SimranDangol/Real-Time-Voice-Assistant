# Real-Time Voice Assistant

A browser-based voice assistant built for low-latency streaming transcription and conversation flow. The current implementation covers the Week 1 milestone: browser microphone capture, WebSocket transport, streaming ASR integration, and real-time transcript updates in the UI.

## Stack

- Frontend: Next.js + React
- Backend: Node.js + Express + ws
- ASR: Deepgram live transcription
- Dev tooling: TypeScript, pnpm, Docker Compose

## Architecture

- `apps/web`: browser client with microphone capture and transcript UI
- `apps/server`: Fastify-style WebSocket session manager, HTTP health endpoint, and Deepgram ASR bridge
- `docker-compose.yml`: Redis and Postgres services for the broader production stack

## Local development

1. Install dependencies
   ```bash
   pnpm install
   ```

2. Copy the environment example and add your keys
   ```bash
   cp .env.example .env
   ```

3. Start the server and web app in separate terminals
   ```bash
   pnpm dev:server
   pnpm dev:web
   ```

4. Open the app in a browser at `http://localhost:3000`

## Environment variables

Required:

- `DEEPGRAM_API_KEY`: API key for Deepgram streaming ASR

Optional:

- `PORT`: server port (default `8080`)
- `NEXT_PUBLIC_WS_URL`: browser WebSocket URL (default `ws://localhost:8080/ws`)

## Week 1 status

Completed for this milestone:

- microphone capture in the browser
- audio streaming to the server over WebSocket
- Deepgram live transcription with partial and final results
- real-time transcript rendering in the interface
- server health endpoint and graceful shutdown

Next milestones in the project roadmap are the LLM/voice reply loop, turn management, streaming TTS, and latency metrics.
