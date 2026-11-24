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
// escapes; matching is unchanged. Main's esbuild build goes through the same
// re-print (#17023): esbuild escapes strings but writes regex literals as they
// are (#16682).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { minifySync } from "rolldown/utils";

/** Code units above U+00FF force a two-byte string in Blink and V8. */
export function hasTwoByteCharacters(code) {
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) > 0xff) return true;
  }
  return false;
}

/**
 * Re-prints a minified ES module chunk with non-ASCII characters escaped.
 * Comments go unless `legalComments` keeps the `/*!`, `@license` ones, which
 * then keep their characters.
 */
export function escapeChunkToAscii(fileName, code, { legalComments = "none" } = {}) {
  const result = minifySync(fileName, code, {
    module: true,
    compress: false,
    mangle: false,
    codegen: { removeWhitespace: true, asciiOnly: true, legalComments },
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

/**
 * esbuild plugin: the same re-print for a one-shot production build of Main,
 * keeping the legal comments esbuild keeps. It takes over writing, so the
 * escaped text is what lands on disk and what a `write: false` caller reads;
 * a rebuild would never remove an output it drops, so watch builds go without.
 * Chunk names keep esbuild's hash: Main and its hosts load chunks from disk,
 * and Node's compile cache checks the source it caches.
 */
export function asciiOnlyOutputPlugin() {
  return {
    name: "ascii-only-output",
    setup(build) {
      const write = build.initialOptions.write !== false;
      // esbuild resolves symlinks in output paths, including macOS's /var.
      const workingDir = fs.realpathSync(build.initialOptions.absWorkingDir ?? process.cwd());
      build.initialOptions.write = false;
      build.onEnd((result) => {
        if (result.errors.length > 0 || !result.outputFiles) return;
        // Every chunk is re-printed before any is written, so a chunk the
        // printer rejects fails the build with nothing on disk.
        for (const file of result.outputFiles) {
          if (!file.path.endsWith(".js") || !hasTwoByteCharacters(file.text)) continue;
          const code = escapeChunkToAscii(file.path, file.text, { legalComments: "inline" });
          file.contents = new TextEncoder().encode(code);
          file.hash = createHash("sha256").update(file.contents).digest("base64url");
          const key = path.relative(workingDir, file.path).split(path.sep).join("/");
          const meta = result.metafile?.outputs[key];
          if (meta) meta.bytes = file.contents.byteLength;
        }
        if (!write) return;
        for (const file of result.outputFiles) {
          fs.mkdirSync(path.dirname(file.path), { recursive: true });
          fs.writeFileSync(file.path, file.contents);
        }
      });
    },
  };
}
