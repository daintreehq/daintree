// Blink decodes a script into an 8-bit string only when every character is
// Latin-1; one em dash or ellipsis in UI copy makes it hold the whole chunk as
// UTF-16, and V8 compiles from that same two-byte source. Every project view is
// its own renderer, so each pays double for every such chunk it loads (#14219).
//
// Rolldown 1.2 can escape non-ASCII at codegen (`codegen.asciiOnly`), but the
// Rolldown bundled inside Vite 8.0 predates the option, so this re-prints the
// already-minified chunks that need it through the newer Rolldown's Oxc
// minifier with compress and mangle off: a parse and print, nothing else.
// Tagged template quasis keep their characters, since a tag can read `raw`.

import { minifySync } from "rolldown/utils";

/** Code units above U+00FF force a two-byte string in Blink and V8. */
export function hasTwoByteCharacters(code) {
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) > 0xff) return true;
  }
  return false;
}

/** Re-prints a minified ES module chunk with non-ASCII characters escaped. */
export function escapeChunkToAscii(fileName, code) {
  const result = minifySync(fileName, code, {
    module: true,
    compress: false,
    mangle: false,
    codegen: { removeWhitespace: true, asciiOnly: true },
  });
  if (result.errors?.length) {
    throw new Error(`ascii-only re-print of ${fileName} failed: ${result.errors[0].message}`);
  }
  return result.code;
}

/**
 * Vite plugin: escapes every emitted JS chunk that would load as two-byte.
 * Runs in generateBundle, after Rolldown's own minifier; must be registered
 * before any plugin that prepends a comment V8 reads from line 1.
 */
export function asciiOnlyChunksPlugin() {
  return {
    name: "ascii-only-chunks",
    apply: "build",
    // Content changes after [hash] is resolved; folding a marker into every
    // hash keeps URL-keyed caches from pairing an old name with new bytes.
    augmentChunkHash() {
      return "ascii-only-1";
    },
    // Post order: vite:build-import-analysis rewrites chunk code in a
    // default-order generateBundle, and the re-print must see the final text.
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk" || !hasTwoByteCharacters(output.code)) continue;
          output.code = escapeChunkToAscii(output.fileName, output.code);
        }
      },
    },
  };
}
