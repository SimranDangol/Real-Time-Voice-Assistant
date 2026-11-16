# eval/recordings/

This directory contains the 35 audio recordings used for Word Error Rate (WER) evaluation and audio file integrity verification.

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
   Inspects each `.wav` file on disk:
   - Validates RIFF/WAVE container header
   - Enforces 16,000 Hz, 16-bit mono PCM audio specifications
   - Computes duration and acoustic sample metrics
   - Verifies each manifest hypothesis against its reference transcript

2. **Live Audio Transcribe Mode (`--live`):**
   ```bash
   pnpm --dir eval wer:live
   # or:
   tsx eval/wer.ts --live [--save]
   ```
   Reads each `.wav` file directly from disk and streams its audio bytes to Deepgram Nova-3 API (`https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true`), computing the WER directly against the live ASR response.

## Tag Definitions

| Tag | Description |
|-----|-------------|
| `clear` | Quiet room, standard microphone, natural pace |
| `noise` | Background acoustic noise present (fan hum, typing transients, music, rain) |
| `fast` | Rapid speech tempo with conversational word elisions |
| `accent` | Non-native English accent with phonetic vowel shifts |
| `tool` | Intent invoking a voice tool (`get_weather`, `get_current_time`, `set_reminder`) |
| `barge-in` | Interruption utterances with onset acoustic cutoff |

## Generating Test Audio

To regenerate or customize the 35 baseline WAV recordings:
```bash
pnpm --dir eval generate:audio
```
