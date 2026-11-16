# eval/recordings/

This directory contains the 35 audio recordings used for Word Error Rate (WER) evaluation.

## Structure

```
recordings/
  manifest.json         # Maps each .wav file to its reference transcript and ASR hypothesis
  r01_weather_clear.wav # Audio files (not committed — add your own recordings)
  r02_time_london.wav
  ...
  r35_noise_rain.wav
```

## Recording Procedure

1. Run the assistant locally (`pnpm dev` in both `apps/server` and `apps/web`).
2. Click **Start**, speak the reference sentence from `manifest.json`, click **Stop**.
3. Save the browser's transcript shown in the UI as the `hypothesis` for that entry.
4. Record the audio using any screen-capture or audio-capture tool (OBS, Audacity, etc.)
   and save it as the corresponding `.wav` file in this directory.
5. Repeat for all 35 entries.

## Tag Definitions

| Tag | Description |
|-----|-------------|
| `clear` | Quiet room, standard microphone, natural pace |
| `noise` | Background noise present (fan, traffic, music, rain) |
| `fast` | Faster-than-normal speech delivery |
| `accent` | Speaker has a non-native English accent |
| `tool` | Query invokes a voice tool (weather, time, reminder) |
| `barge-in` | User interrupts the assistant mid-response |

## Running WER

```bash
pnpm --dir eval wer
# or if you have tsx globally:
tsx eval/wer.ts
```

## Note on .wav files

Audio files are excluded from the repository (see `.gitignore`) to keep the repo lightweight.
To share your eval set, upload the `.wav` files to a separate storage location and link them here.
