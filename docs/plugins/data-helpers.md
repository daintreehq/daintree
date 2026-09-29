# Data helpers — `@daintreehq/plugin-sdk/data`

Most project plugins keep their data as plain files in the repository — a Markdown file per CRM card with YAML frontmatter, a JSON Lines log, a recipe per file — because that is what lets an agent in a terminal read and edit the same data the panel shows. This entry is the handful of helpers every such plugin otherwise writes by hand: a real YAML frontmatter parser, an editor that changes one key without disturbing the rest of the file, JSON Lines parsing that reports bad lines instead of throwing, and the conflict-checked edit loop over `host.fs.writeFile`.

```js
import {
  parseFrontmatter,
  stringifyFrontmatter,
  updateFrontmatter,
  FrontmatterError,
  parseJsonl,
  stringifyJsonlLine,
  contentRevision,
  editFile,
} from "@daintreehq/plugin-sdk/data";
```

The types `ParsedFrontmatter`, `ParsedJsonl`, `JsonlError`, `EditFileHost`, `EditFileTransform`, `EditFileOptions` and `EditFileResult` are exported from the same entry. Everything here runs in a plugin worker and in a view alike; only `editFile` does I/O, and only through the `host.fs` it is handed.

| Export | Signature |
| --- | --- |
| [`parseFrontmatter`](#parsefrontmatter) | `(text: string) => { data, body, hasFrontmatter }` |
| [`stringifyFrontmatter`](#stringifyfrontmatter) | `(data: Record<string, unknown>, body: string) => string` |
| [`updateFrontmatter`](#updatefrontmatter) | `(text: string, patch: Record<string, unknown>) => string` |
| [`FrontmatterError`](#frontmattererror) | `class extends Error { code: "FRONTMATTER_INVALID"; line: number; column: number }` |
| [`parseJsonl`](#parsejsonl) | `(text: string) => { records: unknown[]; errors: JsonlError[] }` |
| [`stringifyJsonlLine`](#stringifyjsonlline) | `(value: unknown) => string` |
| [`editFile`](#editfile) | `(host, filePath, transform, options?) => Promise<{ written: boolean; revision: string \| null }>` |
| [`contentRevision`](#contentrevision) | `(content: string \| Uint8Array) => Promise<string>` |

## No install needed in a worker

A zero-build plugin (hand-written `dist/index.mjs`, see the [agent brief](./agent-brief.md#the-zero-build-skeleton)) has no `node_modules`, so a bare import would normally fail. The plugin worker resolves `@daintreehq/plugin-sdk`, `@daintreehq/plugin-sdk/files` and `@daintreehq/plugin-sdk/data` to a copy of the SDK that ships with Daintree whenever the plugin has none of its own, for `import` and `require()` alike. The import line above works in `dist/index.mjs` as written.

- **Your own copy wins.** If the plugin bundles the SDK or has it installed where Node finds it, that copy is used. The shipped copy is only the fallback when normal resolution fails — including when your installed SDK is too old to export the entry. A broken install (an export naming a file that is not there) is reported as its own error, never papered over with the shipped copy.
- **The shipped copy tracks the app, not your lockfile.** It is the SDK version Daintree was built with. Pin a version by installing and bundling it instead.
- **`/data` is newer than the published SDK.** npm 0.1.0 does not have it. An un-bundled worker gets it from the shipped copy (an installed 0.1.0 falls back to it too), but a plugin or view you _bundle_ against `@daintreehq/plugin-sdk@0.1.0` cannot resolve `@daintreehq/plugin-sdk/data` at build time. Bundled code needs the SDK from this repository (the workspace package, or `npm pack` of it) or a release after 0.1.0.
- **`/react` and `/testing` are not served.** `@daintreehq/plugin-sdk/react` belongs in a view built with `@daintreehq/plugin-vite`; `/testing` is a mock host for unit tests. Importing either from an un-bundled worker fails with `ERR_MODULE_NOT_FOUND` and a message that says why.
- **Views are not covered.** A hand-written `dist/panel.js` still gets only `react` and its own relative modules. Everything in this entry also runs in a browser, so a bundled view can use it (with the SDK caveat above); a raw view keeps its data work in the worker and asks for results over a channel.

## Frontmatter

Frontmatter is a block that opens with `---` on the very first line (a byte order mark before it is allowed) and closes at the next line that is exactly `---`; trailing spaces or tabs on either delimiter are allowed. YAML is read with the 1.2 core schema, so `yes` stays the string `"yes"` and `2026-09-26` stays a string rather than becoming a `Date`.

### `parseFrontmatter`

```ts
parseFrontmatter(text: string): { data: Record<string, unknown>; body: string; hasFrontmatter: boolean }
```

`data` is the mapping as plain values, `body` is everything after the closing line, byte-for-byte, and `hasFrontmatter` says whether the text opened a block. A document without one has `data: {}` and its whole text as `body`. An empty block reads as `{}`. Invalid YAML (including an alias whose anchor is missing), a block that is opened but never closed, and YAML that is not a mapping throw a [`FrontmatterError`](#frontmattererror).

```js
const { data, body } = parseFrontmatter(await host.fs.readFile(cardPath));
// data: { name: "Acme Corp", stage: "lead" }
```

### `stringifyFrontmatter`

```ts
stringifyFrontmatter(data: Record<string, unknown>, body: string): string
```

Writes a fresh block — `undefined` values omitted, long strings never folded — ahead of the body, with `\n` line breaks. The body is appended verbatim, so `parseFrontmatter(stringifyFrontmatter(d, b)).body === b`. Use it to create a file; to change one, use `updateFrontmatter`, which keeps the author's formatting.

```js
await host.fs.writeFile(cardPath, stringifyFrontmatter({ name, stage: "lead" }, "## Notes\n"), {
  expectedRevision: null,
});
```

### `updateFrontmatter`

```ts
updateFrontmatter(text: string, patch: Record<string, unknown>): string
```

The one to reach for when a panel edits a file an agent also edits. It changes only the top-level keys named in `patch` and leaves every other byte alone — comments, key order, quoting, blank lines, and the body — so a UI edit and an agent's edit only collide when they touch the same key:

```js
// Before:                          After updateFrontmatter(text, { stage: "won" }):
// ---                              ---
// name: 'Acme Corp' # keep quotes  name: 'Acme Corp' # keep quotes
// stage: lead # pipeline           stage: won # pipeline
// ---                              ---
```

- **Keys.** A value of `undefined` deletes the key (and only its own lines — a comment above the next key stays). A key that is not present is appended at the end of the block. A document with no frontmatter gains a block holding the patch. An empty patch returns the text untouched, but existing frontmatter is still parsed first, so invalid YAML throws even then.
- **Values.** An edited scalar is swapped in place and keeps its trailing comment. An entry that becomes, or was, a list, a map, a multi-line string or an explicitly tagged scalar has just its own lines rewritten, in the library's default style. An indented root mapping stays indented. CRLF files stay CRLF, including a block added to one.
- **Tags.** A core tag — `!!str`, `!!int`, `!!float`, `!!bool`, `!!null`, `!!map`, `!!seq` — is dropped when its value is replaced, so the new value reads back as the type you passed (`!!str 1` patched with `2` becomes the number `2`). Any other tag — `!!binary`, `!!timestamp`, a custom `!foo` — names a type a plain value cannot carry, so patching that key throws rather than silently changing its type.
- **Anchors and aliases.** A replaced value keeps its anchor, so an `*alias` to it still resolves. The result is read back before it is returned, and an edit that would leave the frontmatter unreadable — typically deleting the anchored key while another key still uses `*alias` — throws.
- **Flow mappings.** A block whose whole mapping is written in flow style (`{ name: Acme, stage: lead }`) cannot be edited in place, so a non-empty patch re-serialises the whole mapping, under the same tag and anchor rules, keeping each replaced value's comments.
- **Complex keys.** A key that is not a plain scalar cannot be edited in place and throws.

Every failure is a [`FrontmatterError`](#frontmattererror). Pair it with [`editFile`](#editfile) so the write is conflict-checked too:

```js
await editFile(host, cardPath, (text) => text && updateFrontmatter(text, { stage: "won" }));
```

### `FrontmatterError`

```ts
class FrontmatterError extends Error {
  readonly code: "FRONTMATTER_INVALID";
  readonly line: number; // 1-based, in the whole file
  readonly column: number; // 1-based
}
```

Thrown by `parseFrontmatter` and `updateFrontmatter`. `line` and `column` are positions in the whole file, not in the YAML block, and are appended to the message, so a listing can report "card 12: line 4" and carry on with the rest.

```js
for (const file of cardFiles) {
  try {
    cards.push(parseFrontmatter(await host.fs.readFile(file)).data);
  } catch (err) {
    if (!(err instanceof FrontmatterError)) throw err;
    problems.push(`${file}: line ${err.line}, column ${err.column}`);
  }
}
```

## JSON Lines

### `parseJsonl`

```ts
parseJsonl(text: string): { records: unknown[]; errors: { line: number; message: string; text: string }[] }
```

Blank lines are skipped, `\r\n` is accepted, and a leading byte order mark is ignored. Each unparseable line becomes `{ line, message, text }` — `line` 1-based, `text` without its line break — instead of an exception, so one corrupt entry does not hide the log. An unparseable final line with no line break is reported as **possibly truncated**: that is what an interrupted append looks like, though it can also be an ordinary malformed record that happens to be last.

```js
const { records, errors } = parseJsonl(await host.fs.readFile(logPath));
for (const e of errors) host.logger.warn(`activity.jsonl line ${e.line}: ${e.message}`);
```

### `stringifyJsonlLine`

```ts
stringifyJsonlLine(value: unknown): string
```

One record with its trailing `\n`, ready to append. JSON escapes line breaks inside strings, so it is always one line. Throws a `TypeError` for a value JSON cannot represent (`undefined`, a function, a symbol). Pair it with `host.fs.appendFile`, which lands each call at the end of the file even while an agent appends to the same log:

```js
await host.fs.appendFile(logPath, stringifyJsonlLine({ at: Date.now(), card: id, stage: "won" }));
```

## Conflict-checked edits

### `editFile`

```ts
editFile(
  host: { fs: Pick<PluginFsApi, "readFileBytes" | "writeFile"> },
  filePath: string,
  transform: (current: string | null) => string | null | undefined | Promise<string | null | undefined>,
  options?: { retries?: number } // default 5
): Promise<{ written: boolean; revision: string | null }>
```

The read → modify → `writeFile({ expectedRevision })` → retry loop:

```js
// A card that has been deleted stays deleted: `null` in, `null` out.
await editFile(host, cardPath, (text) => text && updateFrontmatter(text, { stage: "won" }));

// Create the file if it is missing.
await editFile(host, notesPath, (text) => (text ?? "# Notes\n") + `- ${note}\n`);
```

1. It reads the file's bytes with `host.fs.readFileBytes` and hashes them for the revision. A missing file (`ENOENT`) is `null`.
2. It decodes them as UTF-8, keeping a byte order mark so writing the text back reproduces it. A file that is not valid UTF-8 is refused with an error rather than corrupted.
3. It calls `transform(text)`. Return the new text to write it; return the same text, `null` or `undefined` to leave it alone. Anything else throws a `TypeError`.
4. It writes with `expectedRevision` set to the revision it read — `null` for a missing file, which makes the write a create that fails if the file appears first — so a change already on disk when the write checks is detected and retried rather than overwritten. The check and the rename are separate steps, so a write landing between them is not caught (see [`writeFile`](./host-api.md#fs--host-mediated-scope-contained-filesystem)).
5. If another writer got there first (`REVISION_MISMATCH`, `TARGET_EXISTS`, `TARGET_UNAVAILABLE`), or the read itself hit `TARGET_UNAVAILABLE`, it starts again from step 1, up to `retries` more times, then throws the last error.

It resolves `{ written, revision }`: whether this call wrote, and the file's revision afterwards — of the bytes written, or of the bytes read when nothing was written, or `null` when the file does not exist. Because `transform` can run more than once, compute from its argument rather than from state it changes. Any other error — a missing capability, a path out of scope, a missing parent directory, a declined consent prompt — is thrown straight away. `retries` must be a non-negative integer (`TypeError` otherwise); `0` means one attempt. The error code is read from `err.code` or, failing that, from the message prefix, so it works the same in process and in a worker. `host` is anything with `fs.readFileBytes` and `fs.writeFile`, which includes `PluginHostApi` and `createMockHost()`.

### `contentRevision`

```ts
contentRevision(content: string | Uint8Array): Promise<string>
```

The revision `writeFile` compares against — the lowercase sha256 hex of the bytes, a string hashed as its UTF-8 encoding — for code that manages its own writes. It returns a promise because it uses Web Crypto, so the same call works in a view. Hash the bytes from `readFileBytes`, not the text from `readFile`: a byte order mark or an invalid sequence does not survive decoding. `host.fs.readFileWithRevision` gives you the same value without hashing anything yourself.

```js
const bytes = await host.fs.readFileBytes(boardPath);
const revision = await contentRevision(bytes);
// …later
await host.fs.writeFile(boardPath, next, { expectedRevision: revision });
```
