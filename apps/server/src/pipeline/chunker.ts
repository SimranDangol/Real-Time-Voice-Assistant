/**
 * Sentence Chunker
 *
 * Slices an incoming stream of LLM tokens into complete sentences.
 * This allows the first sentence to be dispatched to TTS immediately,
 * without waiting for the full LLM completion.
 */

// Common abbreviations that shouldn't trigger a sentence break
const ABBREVIATIONS = new Set([
  "mr.",
  "mrs.",
  "ms.",
  "dr.",
  "prof.",
  "sr.",
  "jr.",
  "vs.",
  "e.g.",
  "i.e.",
  "etc.",
  "approx.",
  "appt.",
  "dept.",
  "est.",
  "min.",
]);

export class SentenceChunker {
  private buffer = "";

  
  public push(delta: string): string[] {
    this.buffer += delta;
    const sentences: string[] = [];

    while (true) {
      // Find candidate sentence boundary: punctuation (. ! ?) followed by whitespace or quote
      const match = this.buffer.match(/([.!?])(\s+|$)/);
      if (!match || match.index === undefined) {
        break;
      }

      const punctuationIndex = match.index;
      const delimiterEnd = punctuationIndex + match[0].length;

      // Check if this punctuation is part of a number (e.g. 3.14)
      const isDecimalNumber =
        match[1] === "." &&
        punctuationIndex > 0 &&
        /\d/.test(this.buffer[punctuationIndex - 1]) &&
        punctuationIndex + 1 < this.buffer.length &&
        /\d/.test(this.buffer[punctuationIndex + 1]);

      if (isDecimalNumber) {
        // Skip this match and search further
        break;
      }

      // Check for common abbreviations
      const potentialSentence = this.buffer.slice(0, punctuationIndex + 1);
      const lastWord = potentialSentence.split(/\s+/).pop()?.toLowerCase() ?? "";

      if (ABBREVIATIONS.has(lastWord)) {
        // Avoid splitting on abbreviations unless followed by a double space/newline
        if (!/\n|\s{2,}/.test(match[2])) {
          break;
        }
      }

      // We have a valid sentence
      const sentence = this.buffer.slice(0, delimiterEnd).trim();
      this.buffer = this.buffer.slice(delimiterEnd);

      if (sentence.length > 0) {
        sentences.push(sentence);
      }
    }

    return sentences;
  }

  /**
   * Flush any remaining text in the buffer when the LLM stream finishes.
   */
  public flush(): string | null {
    const remaining = this.buffer.trim();
    this.buffer = "";
    return remaining.length > 0 ? remaining : null;
  }
}

