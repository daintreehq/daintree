import { describe, expect, it } from "vitest";
import {
  appendToAnalysisBuffer,
  trimAnalysisBuffer,
  MAX_ANALYSIS_BUFFER_SIZE,
  MAX_ANALYSIS_BUFFER_HARD_CAP,
} from "../WorkerBufferService.js";
import { extractCodeBlocks, extractPatches } from "../../../shared/utils/artifactParser.js";

/**
 * Simulate the worker's per-chunk flow: append, then trim. Returns the final
 * trimmed buffer and the last untrimmed combined string (what extraction sees).
 */
function feed(chunks: string[], initial = ""): { buffer: string; combined: string } {
  let buffer = initial;
  let combined = initial;
  for (const chunk of chunks) {
    combined = appendToAnalysisBuffer(buffer, chunk);
    buffer = trimAnalysisBuffer(combined);
  }
  return { buffer, combined };
}

/** Prose filler that contains no fence- or patch-shaped lines. */
function prose(lines: number): string {
  let out = "";
  for (let i = 0; i < lines; i++) {
    out += `terminal output line ${i} with some ordinary text\n`;
  }
  return out;
}

function chunked(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

describe("appendToAnalysisBuffer", () => {
  it("concatenates previous buffer and chunk", () => {
    expect(appendToAnalysisBuffer("abc", "def")).toBe("abcdef");
  });

  it("normalizes CRLF to LF", () => {
    expect(appendToAnalysisBuffer("a\r\nb", "c\r\nd")).toBe("a\nb" + "c\nd");
  });

  it("normalizes a CRLF pair split across the chunk boundary", () => {
    expect(appendToAnalysisBuffer("line\r", "\nnext")).toBe("line\nnext");
  });
});

describe("trimAnalysisBuffer", () => {
  it("returns the buffer unchanged when within the window", () => {
    const buffer = prose(10);
    expect(buffer.length).toBeLessThanOrEqual(MAX_ANALYSIS_BUFFER_SIZE);
    expect(trimAnalysisBuffer(buffer)).toBe(buffer);
  });

  it("trims plain output to the window tail", () => {
    const buffer = prose(500);
    expect(buffer.length).toBeGreaterThan(MAX_ANALYSIS_BUFFER_SIZE * 2);
    const trimmed = trimAnalysisBuffer(buffer);
    expect(trimmed.length).toBe(MAX_ANALYSIS_BUFFER_SIZE);
    expect(buffer.endsWith(trimmed)).toBe(true);
  });

  it("keeps the opening fence of a code block larger than the window", () => {
    const body = prose(300); // well over the 5KB window
    const buffer = trimAnalysisBuffer(prose(50) + "```typescript\n" + body);
    expect(buffer.startsWith("```typescript\n")).toBe(true);
    expect(buffer.length).toBeGreaterThan(MAX_ANALYSIS_BUFFER_SIZE);
  });

  it("keeps an indented (up to 3 spaces) opening fence", () => {
    const buffer = trimAnalysisBuffer(prose(50) + "   ```python\n" + prose(300));
    expect(buffer.startsWith("   ```python\n")).toBe(true);
  });

  it("releases the fence anchor once the block closes", () => {
    const closed = prose(50) + "```ts\n" + prose(300) + "```\n" + prose(50);
    const trimmed = trimAnalysisBuffer(closed);
    expect(trimmed.length).toBeLessThanOrEqual(MAX_ANALYSIS_BUFFER_SIZE);
  });

  it("falls back to the plain tail when an open fence exceeds the hard cap", () => {
    const hugeBody = "x".repeat(MAX_ANALYSIS_BUFFER_HARD_CAP + 1000) + "\n";
    const trimmed = trimAnalysisBuffer("```ts\n" + hugeBody);
    expect(trimmed.length).toBe(MAX_ANALYSIS_BUFFER_SIZE);
    expect(trimmed.includes("```")).toBe(false);
  });

  it("does not mistake a stranded closing fence for an opener", () => {
    // A closed block bigger than the window: the closing fence would land in
    // the plain tail. The parity fixup must advance the cut past it so later
    // rounds don't anchor on it and over-retain.
    const closed = prose(20) + "```ts\n" + prose(400) + "```\n";
    let buffer = trimAnalysisBuffer(closed);
    expect(buffer.includes("```")).toBe(false);

    // Subsequent plain prose must not accumulate beyond the window.
    for (let i = 0; i < 20; i++) {
      buffer = trimAnalysisBuffer(appendToAnalysisBuffer(buffer, prose(50)));
    }
    expect(buffer.length).toBe(MAX_ANALYSIS_BUFFER_SIZE);
  });

  it("keeps the start of a patch larger than the window", () => {
    let patch =
      "diff --git a/src/big.ts b/src/big.ts\n--- a/src/big.ts\n+++ b/src/big.ts\n@@ -1,300 +1,300 @@\n";
    for (let i = 0; i < 300; i++) {
      patch += `+const generated${i} = ${i};\n`;
    }
    const buffer = trimAnalysisBuffer(prose(50) + patch);
    expect(buffer.startsWith("diff --git a/src/big.ts")).toBe(true);
    expect(buffer.length).toBeGreaterThan(MAX_ANALYSIS_BUFFER_SIZE);
  });

  it("releases the patch anchor once a non-patch line terminates it", () => {
    let patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,300 +1,300 @@\n";
    for (let i = 0; i < 300; i++) {
      patch += `+const generated${i} = ${i};\n`;
    }
    const terminated = prose(20) + patch + "Done applying patch\n" + prose(5);
    expect(terminated.length).toBeGreaterThan(MAX_ANALYSIS_BUFFER_SIZE);
    const trimmed = trimAnalysisBuffer(terminated);
    expect(trimmed.length).toBeLessThanOrEqual(MAX_ANALYSIS_BUFFER_SIZE);
    expect(trimmed.startsWith("diff --git")).toBe(false);
  });

  it("does not let a partial final line terminate an open patch", () => {
    let patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,300 +1,300 @@\n";
    for (let i = 0; i < 300; i++) {
      patch += `+const generated${i} = ${i};\n`;
    }
    expect((prose(20) + patch).length).toBeGreaterThan(MAX_ANALYSIS_BUFFER_SIZE);
    // Final line is mid-stream and not patch-shaped yet; the patch must stay
    // anchored until the line completes.
    const buffer = trimAnalysisBuffer(prose(20) + patch + "Done app");
    expect(buffer.startsWith("diff --git a/a b/a")).toBe(true);
  });
});

describe("multi-chunk artifact survival (#9999)", () => {
  it("extracts a code block whose body exceeds the window when fed in chunks", () => {
    const body = prose(400); // ~18KB body
    const block = "```typescript\n" + body + "```\n";
    const { combined } = feed(chunked(prose(30) + block, 1024));

    const blocks = extractCodeBlocks(combined);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.language).toBe("typescript");
    expect(blocks[0]!.content).toBe(body.trim());
  });

  it("extracts a patch whose body exceeds the window when fed in chunks", () => {
    let patch =
      "diff --git a/src/big.ts b/src/big.ts\n--- a/src/big.ts\n+++ b/src/big.ts\n@@ -1,400 +1,400 @@\n";
    for (let i = 0; i < 400; i++) {
      patch += `+const generated${i} = ${i};\n`;
    }
    const { combined } = feed(chunked(prose(30) + patch + "All done\n", 1024));

    const patches = extractPatches(combined);
    expect(patches.length).toBeGreaterThanOrEqual(1);
    const largest = patches.reduce((a, b) => (a.length >= b.length ? a : b));
    expect(largest).toContain("+const generated0 = 0;");
    expect(largest).toContain("+const generated399 = 399;");
  });

  it("extracts a large code block delivered with CRLF line endings", () => {
    const body = prose(300).replace(/\n/g, "\r\n");
    const block = "```js\r\n" + body + "```\r\n";
    const { combined } = feed(chunked(block, 512));

    const blocks = extractCodeBlocks(combined);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.language).toBe("js");
    expect(blocks[0]!.content).toBe(prose(300).trim());
  });

  it("drops a never-closing fence at the hard cap without unbounded growth", () => {
    const chunks = ["```ts\n", ...Array.from({ length: 60 }, () => "y".repeat(20_000) + "\n")];
    const { buffer } = feed(chunks);
    expect(buffer.length).toBeLessThanOrEqual(MAX_ANALYSIS_BUFFER_HARD_CAP);
  });

  it("keeps the trimmed buffer flat and window-sized during steady prose", () => {
    const { buffer } = feed(chunked(prose(1000), 2048));
    expect(buffer.length).toBe(MAX_ANALYSIS_BUFFER_SIZE);
  });
});
