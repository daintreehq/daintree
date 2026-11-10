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
// Regex literals are escaped too, so `RegExp.prototype.source` reads the
// escapes; matching is unchanged.

import { minifySync, parseSync, Visitor } from "rolldown/utils";

/** Code units above U+00FF force a two-byte string in Blink and V8. */
export function hasTwoByteCharacters(code) {
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) > 0xff) return true;
  }
  return false;
}

/**
 * Offsets of the code units above U+00FF that an escape could remove: every
 * one outside a tagged template's quasis, whose `raw` text a tag can read.
 * Main's esbuild build has no re-print pass, so its chunks are checked
 * against their source instead (#16682).
 */
export function findEscapableTwoByteCharacters(fileName, code) {
  if (!hasTwoByteCharacters(code)) return [];
  const result = parseSync(fileName, code, { sourceType: "module" });
  if (result.errors.length) {
    throw new Error(`parsing ${fileName} failed: ${result.errors[0].message}`);
  }
  const quasis = [];
  new Visitor({
    TaggedTemplateExpression(node) {
      for (const quasi of node.quasi.quasis) quasis.push(quasi);
    },
  }).visit(result.program);
  quasis.sort((a, b) => a.start - b.start);

  const offsets = [];
  let next = 0;
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) <= 0xff) continue;
    while (next < quasis.length && quasis[next].end <= i) next++;
    if (next < quasis.length && quasis[next].start <= i) continue;
    offsets.push(i);
  }
  return offsets;
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
