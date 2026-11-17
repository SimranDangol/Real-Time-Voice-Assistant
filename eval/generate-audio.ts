import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const recordingsDir = path.join(__dirname, "recordings");
const fixturesDir = path.join(__dirname, "fixtures", "synthetic-recordings");
const manifestPath = path.join(recordingsDir, "manifest.json");

fs.mkdirSync(fixturesDir, { recursive: true });

interface ManifestEntry {
  id: string;
  file: string;
  reference: string;
  hypothesis: string;
  tags?: string[];
  notes?: string;
}

/**
 * Creates synthetic tones for WAV parser tests. These are not speech recordings.
 */
function createWavBuffer(text: string, tags: string[] = []): Buffer {
  const sampleRate = 16000;
  const words = text.split(" ").filter(Boolean);
  // Approximately 200-300ms per word + lead-in / lead-out
  const durationSec = Math.max(1.2, words.length * 0.28 + 0.5);
  const totalSamples = Math.floor(sampleRate * durationSec);
  const byteRate = sampleRate * 2; // 1 channel, 16 bits = 2 bytes per sample
  const dataSize = totalSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // 1. RIFF Header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  // 2. "fmt " Subchunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);         // Subchunk1Size for PCM
  buffer.writeUInt16LE(1, 20);          // AudioFormat: 1 = PCM
  buffer.writeUInt16LE(1, 22);          // NumChannels: 1 = mono
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate: 16000
  buffer.writeUInt32LE(byteRate, 28);   // ByteRate: 32000
  buffer.writeUInt16LE(2, 32);          // BlockAlign: 2 bytes
  buffer.writeUInt16LE(16, 34);         // BitsPerSample: 16 bits

  // 3. "data" Subchunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  const isNoise = tags.includes("noise");
  const isFast = tags.includes("fast");
  const f0 = 140; // Fundamental voice frequency in Hz (male/female neutral speech)

  // Generate acoustic waveform: modulated voice formants + syllabic envelope + noise
  let offset = 44;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    // Syllabic envelope: ~3-4 syllables per second
    const syllableRate = isFast ? 5.5 : 3.8;
    const syllableEnvelope = Math.max(0, Math.sin(2 * Math.PI * syllableRate * t));

    // Formants (F0=140Hz, F1=500Hz, F2=1500Hz, F3=2500Hz)
    const voice =
      0.5 * Math.sin(2 * Math.PI * f0 * t) +
      0.3 * Math.sin(2 * Math.PI * 520 * t) +
      0.15 * Math.sin(2 * Math.PI * 1480 * t) +
      0.05 * Math.sin(2 * Math.PI * 2500 * t);

    // Background acoustic noise simulation
    let noise = (Math.random() * 2 - 1) * 0.02;
    if (isNoise) {
      // Fan/traffic low-frequency noise (60-120Hz) + white noise hiss
      const ambient = 0.08 * Math.sin(2 * Math.PI * 65 * t) + (Math.random() * 2 - 1) * 0.06;
      noise += ambient;
    }

    // Lead-in and lead-out fade (50ms)
    const fadeIn = Math.min(1, i / (sampleRate * 0.05));
    const fadeOut = Math.min(1, (totalSamples - i) / (sampleRate * 0.05));
    const boundaryFade = fadeIn * fadeOut;

    const sampleFloat = (voice * syllableEnvelope * 0.65 + noise) * boundaryFade;
    // Clamp to 16-bit signed integer range [-32768, 32767]
    const sampleInt = Math.max(-32768, Math.min(32767, Math.floor(sampleFloat * 32767)));
    buffer.writeInt16LE(sampleInt, offset);
    offset += 2;
  }

  return buffer;
}

const manifest: ManifestEntry[] = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
console.log(`Generating ${manifest.length} synthetic WAV fixtures in ${fixturesDir}...`);

for (const entry of manifest) {
  const filePath = path.join(fixturesDir, path.basename(entry.file));
  const wavBuffer = createWavBuffer(entry.reference, entry.tags);
  fs.writeFileSync(filePath, wavBuffer);
  console.log(`  ✓ Created ${path.basename(filePath)} (${(wavBuffer.length / 1024).toFixed(1)} KB)`);
}

console.log("\nSynthetic fixtures are for parser checks only, not WER or ASR evaluation.");
