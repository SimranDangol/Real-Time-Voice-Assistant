# eval/recordings/

Place genuine microphone recordings here for Word Error Rate (WER) evaluation. WAV header checks only validate container and format; they do not prove that a file contains speech or that its transcript matches the audio.

## Structure

```
recordings/
  manifest.json         # Maps each .wav file to its reference transcript, hypothesis, tags, and acoustic notes
  r01_weather_clear.wav # 16 kHz 16-bit mono PCM audio recording
  r02_time_london.wav
  ...
  r35_noise_rain.wav
```

## Audio Verification & Live Evaluation

The evaluation script (`eval/wer.ts`) supports two operating modes:

1. **Audio Integrity Verification Mode (Default):**
   ```bash
   pnpm --dir eval wer
   ```
   Calculates WER from the manifest's text hypotheses and inspects available `.wav` files:
   - Validates RIFF/WAVE container header
   - Enforces 16,000 Hz, 16-bit mono PCM audio specifications
   - Computes file duration
   - Does not run ASR or validate transcript provenance

2. **Live Audio Transcribe Mode (`--live`):**
   ```bash
   pnpm --dir eval wer:live
   # or:
   tsx eval/wer.ts --live [--save]
   ```
   Reads each `.wav` file directly from disk and sends its audio bytes to Deepgram Nova-3, computing WER against the live response. Set `DEEPGRAM_API_KEY` in the process environment; the script does not read `.env`.

## Tag Definitions

| Tag | Description |
|-----|-------------|
| `clear` | Quiet room, standard microphone, natural pace |
| `noise` | Background acoustic noise present (fan hum, typing transients, music, rain) |
| `fast` | Rapid speech tempo with conversational word elisions |
| `accent` | Non-native English accent with phonetic vowel shifts |
| `tool` | Intent invoking a voice tool (`get_weather`, `get_current_time`, `set_reminder`) |
| `barge-in` | Interruption utterances with onset acoustic cutoff |

## Synthetic Parser Fixtures

Synthetic fixtures can be generated separately:
```bash
pnpm --dir eval generate:synthetic-audio
```
They are written to `eval/fixtures/synthetic-recordings/` and are not speech recordings; do not use them for WER or live ASR results.
