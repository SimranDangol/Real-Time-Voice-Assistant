/**
 * Audio Processor AudioWorklet
 *
 * Captures mono float32 samples from the microphone, downsamples to 16 kHz
 * (in case the AudioContext runs at a higher rate), converts to PCM-16, and
 * posts 20 ms chunks (320 samples) to the main thread.
 *
 * 
 */

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 320; // 20 ms @ 16 kHz

class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {number[]} */
    this._buf = [];
    // How many source samples correspond to one output sample.
    // If the AudioContext was created with { sampleRate: 16000 } this is 1.
    this._ratio = sampleRate / TARGET_RATE;
    this._srcPos = 0; // fractional position in the source stream
  }

  /**
   * @param {Float32Array[][]} inputs
   */
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    for (let i = 0; i < channel.length; i++) {
      // Emit one output sample every `ratio` input samples (nearest-neighbour).
      if (i >= this._srcPos) {
        this._buf.push(channel[i]);
        this._srcPos += this._ratio;

        // Flush a 20 ms frame when we have enough samples
        if (this._buf.length >= FRAME_SAMPLES) {
          const chunk = this._buf.splice(0, FRAME_SAMPLES);
          const pcm16 = new Int16Array(FRAME_SAMPLES);
          for (let j = 0; j < FRAME_SAMPLES; j++) {
            const s = Math.max(-1, Math.min(1, chunk[j]));
            pcm16[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          // Transfer the buffer (zero-copy)
          this.port.postMessage({ pcm16: pcm16.buffer }, [pcm16.buffer]);
        }
      }
    }

    // Keep srcPos relative to the next block
    this._srcPos -= channel.length;

    return true; // keep processor alive
  }
}

registerProcessor("audio-processor", AudioProcessor);

