// Type surface for ascii-only-chunks.mjs so vite.config.ts can import it.

import type { Plugin } from "vite";

/** True when the code holds a code unit above U+00FF. */
export function hasTwoByteCharacters(code: string): boolean;

/** Offsets of the code units above U+00FF outside tagged template quasis. */
export function findEscapableTwoByteCharacters(fileName: string, code: string): number[];

/** Re-prints a minified ES module chunk with non-ASCII characters escaped. */
export function escapeChunkToAscii(fileName: string, code: string): string;

/** Escapes every emitted JS chunk that would otherwise load as a two-byte string. */
export function asciiOnlyChunksPlugin(): Plugin;
