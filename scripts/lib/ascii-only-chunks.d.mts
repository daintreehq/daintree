// Type surface for ascii-only-chunks.mjs so vite.config.ts and typed tests can import it.

import type { Plugin as EsbuildPlugin } from "esbuild";
import type { Plugin } from "vite";

/** True when the code holds a code unit above U+00FF. */
export function hasTwoByteCharacters(code: string): boolean;

/** Re-prints a minified ES module chunk with non-ASCII characters escaped. */
export function escapeChunkToAscii(
  fileName: string,
  code: string,
  options?: { legalComments?: "none" | "inline" | "eof" }
): string;

/** Escapes every emitted JS chunk that would otherwise load as a two-byte string. */
export function asciiOnlyChunksPlugin(): Plugin;

/** Escapes every JS output of a one-shot esbuild build that would load as two-byte, and writes it. */
export function asciiOnlyOutputPlugin(): EsbuildPlugin;
