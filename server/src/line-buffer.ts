export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Splits a text stream into `\n`-terminated lines. Each chunk is scanned once
 * and an unterminated tail is kept as pieces, so a multi-megabyte line (a
 * preview's base64) costs linear time instead of a rescan per chunk.
 */
export class LineBuffer {
  private parts: string[] = [];
  private bytes = 0;

  /** Returns false and discards the remainder when a frame exceeds the byte limit. */
  push(chunk: string, onLine: (line: string) => void, limit: () => number = () => MAX_FRAME_BYTES): boolean {
    let start = 0;
    let idx: number;
    while ((idx = chunk.indexOf("\n", start)) !== -1) {
      if (!this.append(chunk.slice(start, idx), limit())) return false;
      const line = this.parts.join("").trim();
      this.parts = [];
      this.bytes = 0;
      start = idx + 1;
      if (line) onLine(line);
    }
    if (start < chunk.length) {
      return this.append(start === 0 ? chunk : chunk.slice(start), limit());
    }
    return true;
  }

  private append(part: string, limit: number): boolean {
    this.bytes += Buffer.byteLength(part);
    if (this.bytes > limit) {
      this.clear();
      return false;
    }
    if (part.length) this.parts.push(part);
    return true;
  }

  /** UTF-8 size of the unterminated tail. */
  pendingBytes(): number {
    return this.bytes;
  }

  clear(): void {
    this.parts = [];
    this.bytes = 0;
  }
}
