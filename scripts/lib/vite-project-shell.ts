import type { Plugin } from "vite";
import path from "path";
import {
  PROJECT_SHELL_CHUNK_NAME,
  PROJECT_SHELL_SOURCE,
} from "../../shared/config/projectShell.ts";

/**
 * Must match `BUILT_SHELL_FILE` in src/projectWindow/projectShellUrl.ts. A
 * mismatch cannot ship: generateBundle fails the build unless exactly one chunk
 * carried the placeholder and none still does.
 */
export const PROJECT_SHELL_FILE_PLACEHOLDER = "__DAINTREE_PROJECT_SHELL_FILE__";

export function isProjectShellChunkName(name: string): boolean {
  return name === PROJECT_SHELL_CHUNK_NAME;
}

/**
 * Replaces the placeholder in `code` with the shell chunk's file name, relative
 * to the chunk carrying it (what `new URL(…, import.meta.url)` resolves
 * against). Returns null when `code` doesn't carry it.
 */
export function rewriteProjectShellPlaceholder(
  code: string,
  chunkFileName: string,
  shellFileName: string
): string | null {
  if (!code.includes(PROJECT_SHELL_FILE_PLACEHOLDER)) return null;
  const relative = path.posix.relative(path.posix.dirname(chunkFileName), shellFileName);
  const specifier = relative.startsWith(".") ? relative : `./${relative}`;
  return code.replaceAll(PROJECT_SHELL_FILE_PLACEHOLDER, specifier);
}

/**
 * Emits the project window's shell (src/projectWindow/projectShell.tsx) as an
 * entry chunk of its own and points `PROJECT_SHELL_URL` at it.
 *
 * `src/main.tsx` is the renderer entry for every window role, so anything it
 * imports statically evaluates in a plugin surface host and the Canopy window
 * too. The shell can't sit behind `import()` instead: a dynamic import never
 * holds the load event, and main sends to listeners the shell installs as soon
 * as `did-finish-load` fires. The entry loads it with a `<script type="module">`
 * element, which does hold the load event until the graph has evaluated, and
 * that needs the emitted chunk's real URL.
 *
 * As an entry, the shell's static closure stays `$initial`, so the `boot`
 * codeSplitting group keeps it in the same few startup chunks as before, and
 * the first-render preload seeds (getFirstRenderPreloadSeeds) preload it from
 * index.html. The renderChunk rewrite runs before hashing, so the carrying
 * chunk's hash follows the shell's.
 */
export function projectShellChunkPlugin(): Plugin {
  let root = process.cwd();
  let shellRef: string | undefined;
  let rewrites: string[] = [];

  return {
    name: "project-shell-chunk",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    buildStart() {
      rewrites = [];
      shellRef = this.emitFile({
        type: "chunk",
        id: path.resolve(root, PROJECT_SHELL_SOURCE),
        name: PROJECT_SHELL_CHUNK_NAME,
      });
    },
    renderChunk(code, chunk) {
      if (shellRef === undefined) return null;
      const rewritten = rewriteProjectShellPlaceholder(
        code,
        chunk.fileName,
        this.getFileName(shellRef)
      );
      if (rewritten === null) return null;
      rewrites.push(chunk.fileName);
      return { code: rewritten, map: null };
    },
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((output) => output.type === "chunk");
      const leftovers = chunks
        .filter((chunk) => chunk.code.includes(PROJECT_SHELL_FILE_PLACEHOLDER))
        .map((chunk) => chunk.fileName);
      if (leftovers.length > 0) {
        this.error(
          `[project-shell-chunk] the project shell URL placeholder survived in ${leftovers.join(", ")}`
        );
      }
      if (rewrites.length !== 1) {
        this.error(
          `[project-shell-chunk] expected one chunk to carry the project shell URL (src/projectWindow/projectShellUrl.ts), found ${rewrites.length}` +
            (rewrites.length > 0 ? `: ${rewrites.join(", ")}` : "")
        );
      }
      const shell = chunks.find((chunk) => isProjectShellChunkName(chunk.name));
      if (!shell?.isEntry) {
        this.error(
          `[project-shell-chunk] no entry chunk named "${PROJECT_SHELL_CHUNK_NAME}" holds ${PROJECT_SHELL_SOURCE}`
        );
      }
    },
  };
}
