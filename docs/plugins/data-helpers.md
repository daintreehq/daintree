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

## No install needed in a worker

A zero-build plugin (hand-written `dist/index.mjs`, see the [agent brief](./agent-brief.md#the-zero-build-skeleton)) has no `node_modules`, so a bare import would normally fail. The plugin worker resolves `@daintreehq/plugin-sdk`, `@daintreehq/plugin-sdk/files` and `@daintreehq/plugin-sdk/data` to a copy of the SDK that ships with Daintree whenever the plugin has none of its own. The import line above works in `dist/index.mjs` as written.

- **Your own copy wins.** If the plugin bundles the SDK or has it installed where Node finds it, that copy is used. The shipped copy is only the fallback when normal resolution fails — including when your installed SDK is too old to have the entry.
- **The shipped copy tracks the app, not your lockfile.** It is the SDK version Daintree was built with. Pin a version by installing and bundling it instead.
- **`/data` is newer than the published SDK.** npm 0.1.0 does not have it; a worker gets it from the shipped copy (an installed 0.1.0 falls back to it too) until the next SDK release.
- **`/react` and `/testing` are not served.** `@daintreehq/plugin-sdk/react` belongs in a view built with `@daintreehq/plugin-vite`; `/testing` is a mock host for unit tests. Importing either from an un-bundled worker fails with an error that says so.
- **Views are not covered.** A hand-written `dist/panel.js` still gets only `react` and its own relative modules. Everything in this entry also runs in a browser, so a bundled view can use it; a raw view keeps its data work in the worker and asks for results over a channel.

## Frontmatter

`parseFrontmatter(text)` returns `{ data, body, hasFrontmatter }`. Frontmatter is a block that opens with `---` on the very first line and closes at the next line that is exactly `---`; a document without it has `data: {}` and its whole text as `body`. The body is returned byte-for-byte. YAML is read with the 1.2 core schema, so `yes` stays the string `"yes"` and `2026-09-26` stays a string rather than becoming a `Date`.

Invalid YAML, a block that is opened but never closed, and YAML that is not a mapping throw a `FrontmatterError` whose `line` and `column` are positions in the whole file, so a listing can report "card 12: line 4" and carry on with the rest.

`stringifyFrontmatter(data, body)` writes a fresh block (omitting `undefined` values) ahead of the body.

`updateFrontmatter(text, patch)` is the one to reach for when a panel edits a file an agent also edits. It changes only the top-level keys named in `patch` and leaves every other byte alone — comments, key order, quoting, blank lines, and the body:

```js
// Before:                          After updateFrontmatter(text, { stage: "won" }):
// ---                              ---
// name: 'Acme Corp' # keep quotes  name: 'Acme Corp' # keep quotes
// stage: lead # pipeline           stage: won # pipeline
// ---                              ---
```

A value of `undefined` deletes the key (and only its own lines — a comment above the next key stays). A key that is not present is appended at the end of the block. An edited scalar keeps its trailing comment; an entry that becomes, or was, a list, a map or a multi-line string has just its own lines rewritten. A document with no frontmatter gains a block. CRLF files stay CRLF.

## JSON Lines

`parseJsonl(text)` returns `{ records, errors }`. Blank lines are skipped, `\r\n` is accepted, and each unparseable line becomes `{ line, message, text }` instead of an exception, so one corrupt entry does not hide the log. An unparseable final line with no line break is reported as **truncated** — the mark of a write that was cut off rather than a malformed record.

`stringifyJsonlLine(value)` is one record with its trailing `\n`, ready to append. JSON escapes line breaks inside strings, so it is always one line.

## Conflict-checked edits

`editFile(host, path, transform, { retries = 5 })` is the read → modify → `writeFile({ expectedRevision })` → retry loop:

```js
// A card that has been deleted stays deleted: `null` in, `null` out.
await editFile(host, cardPath, (text) => text && updateFrontmatter(text, { stage: "won" }));

await editFile(host, logPath, (text) => (text ?? "") + stringifyJsonlLine(entry));
```

1. It reads the file's bytes with `host.fs.readFileBytes` and hashes them for the revision.
2. It calls `transform(text)` — `text` is `null` when the file does not exist. Return the new text to write it; return the same text, `null` or `undefined` to leave it alone.
3. It writes with `expectedRevision` (or `null` to create), so a change made since the read is never overwritten.
4. If another writer got there first (`REVISION_MISMATCH`, `TARGET_EXISTS`, `TARGET_UNAVAILABLE`), it re-reads and calls `transform` again with the new text, up to `retries` more times, then throws the last conflict.

It resolves `{ written, revision }`. Because `transform` can run more than once, compute from its argument rather than from state it changes. Any other error — a missing capability, a path out of scope, a missing parent directory — is thrown straight away. A file that is not valid UTF-8 is refused rather than corrupted. `host` is anything with `fs.readFileBytes` and `fs.writeFile`, which includes `PluginHostApi` and `createMockHost()`.

`contentRevision(textOrBytes)` is the revision `writeFile` compares against — the sha256 hex of the UTF-8 bytes — for code that manages its own writes. It returns a promise because it uses Web Crypto, so the same call works in a view. Hash the bytes from `readFileBytes`, not the text from `readFile`: a byte order mark or an invalid sequence does not survive decoding.
