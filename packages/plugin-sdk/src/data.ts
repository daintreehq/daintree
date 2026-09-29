/**
 * `@daintreehq/plugin-sdk/data` — helpers for plugins whose data is plain
 * files in the repository: Markdown with YAML frontmatter, JSON Lines logs,
 * and the conflict-checked edit that lets a panel and an agent share a file.
 *
 * Everything here runs in a plugin worker and in a panel view alike. Only
 * {@link editFile} does I/O, and only through the `host.fs` it is handed;
 * {@link contentRevision} is async because it hashes with Web Crypto.
 *
 * A zero-build worker (hand-written `dist/index.mjs`, no `node_modules`) can
 * import this entry without installing anything: Daintree's plugin worker
 * serves `@daintreehq/plugin-sdk`, `/files` and `/data` from a copy that ships
 * with the app whenever the plugin has no SDK of its own.
 */

export {
  parseFrontmatter,
  stringifyFrontmatter,
  updateFrontmatter,
  FrontmatterError,
} from "./data/frontmatter.js";

export type { ParsedFrontmatter } from "./data/frontmatter.js";

export { parseJsonl, stringifyJsonlLine } from "./data/jsonl.js";

export type { ParsedJsonl, JsonlError } from "./data/jsonl.js";

export { contentRevision } from "./data/revision.js";

export { editFile } from "./data/editFile.js";

export type {
  EditFileHost,
  EditFileTransform,
  EditFileOptions,
  EditFileResult,
} from "./data/editFile.js";
