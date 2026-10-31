import fsp, { open as namedOpen } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type { AgentSubagent } from "../../../shared/types/ipc/agentSubagents";
import { createPerfTempRoot, releasePerfTempRoot } from "./tempRoots";

/**
 * Fixture and apparatus for PERF-414..418, the Claude subagent list (#15681).
 *
 * Builds a store of real transcripts and sidecars shaped like Claude Code's
 * (`<session>/subagents/agent-<id>.jsonl` beside `agent-<id>.meta.json`),
 * observes the filesystem calls a list makes, and records what it wrote so the
 * rows a list returns can be graded against the fixture's own account of them
 * as well as against the frozen pre-#15681 reader.
 */

type ReaderModule = typeof import("../../../electron/services/claude/ClaudeSubagentReader");
type ReferenceModule = typeof import("./claudeSubagentReference");

export interface ListArm {
  name: "current" | "reference";
  list: (dir: string, now: number) => Promise<AgentSubagent[]>;
  reset: () => void;
}

export interface ClaudeSubagentArms {
  current: ListArm;
  reference: ListArm;
  readerStats: ReaderModule["__claudeSubagentCacheStats"];
  referenceStats: ReferenceModule["referenceCacheStats"];
}

let armsPromise: Promise<ClaudeSubagentArms> | null = null;

/**
 * Loaded lazily, per the harness's lazy-fixture rule: `scenarios/index.ts`
 * imports every scenario module up front, so product code pulled in at module
 * scope would be charged to every run whichever id was selected.
 */
export function loadClaudeSubagentArms(): Promise<ClaudeSubagentArms> {
  armsPromise ??= (async () => {
    const reader: ReaderModule =
      await import("../../../electron/services/claude/ClaudeSubagentReader");
    const reference: ReferenceModule = await import("./claudeSubagentReference");
    return {
      current: {
        name: "current",
        list: (dir, now) => reader.listSubagentsInDir(dir, { now: () => now }),
        reset: () => reader.__resetClaudeSubagentCaches(),
      },
      reference: {
        name: "reference",
        list: (dir, now) => reference.listSubagentsInDir(dir, { now: () => now }),
        reset: () => reference.resetReferenceProbeCache(),
      },
      readerStats: () => reader.__claudeSubagentCacheStats(),
      referenceStats: () => reference.referenceCacheStats(),
    };
  })();
  return armsPromise;
}

// --- Filesystem observer -----------------------------------------------------

export interface FsTally {
  transcriptOpens: number;
  sidecarOpens: number;
  transcriptReadBytes: number;
  sidecarReadBytes: number;
  readCalls: number;
  lstatCalls: number;
}

export function emptyTally(): FsTally {
  return {
    transcriptOpens: 0,
    sidecarOpens: 0,
    transcriptReadBytes: 0,
    sidecarReadBytes: 0,
    readCalls: 0,
    lstatCalls: 0,
  };
}

const tally = emptyTally();
const injectedFaults = new Set<string>();
let observedRoot: string | null = null;
let restoreHooks: (() => void) | null = null;
let installedOpen: unknown = null;

type FileKind = "transcript" | "sidecar";

function toPath(target: unknown): string | null {
  if (typeof target === "string") return target;
  if (target instanceof URL) return fileURLToPath(target);
  if (Buffer.isBuffer(target)) return target.toString("utf8");
  return null;
}

function classify(target: string | null): FileKind | null {
  if (!target || !observedRoot || !target.startsWith(observedRoot + path.sep)) return null;
  if (target.endsWith(".meta.json")) return "sidecar";
  if (target.endsWith(".jsonl")) return "transcript";
  return null;
}

type OpenFn = (...args: unknown[]) => Promise<unknown>;
type LstatFn = (...args: unknown[]) => Promise<unknown>;
type ReadFn = (...args: unknown[]) => Promise<{ bytesRead: number }>;

/**
 * Count the opens, reads and `lstat`s a list makes under `root`.
 *
 * Patches the mutable `fs/promises` exports object and then resynchronises
 * the builtin's ESM facade, which is what moves a named `import { open }`
 * binding — the form both readers use — onto the wrapper. Without the sync a
 * named binding keeps the original and the observer is blind to the subject.
 * `fsObserverQualification` proves the binding moved before any count is
 * trusted. Paths outside `root` pass straight through uncounted.
 */
export function installFsObserver(root: string): void {
  uninstallFsObserver();
  observedRoot = root;
  const target = fsp as unknown as { open: OpenFn; lstat: LstatFn };
  const realOpen = target.open;
  const realLstat = target.lstat;

  const observedOpen: OpenFn = async function (this: unknown, ...args: unknown[]) {
    const file = toPath(args[0]);
    const kind = classify(file);
    if (kind && file && injectedFaults.has(file)) {
      throw Object.assign(new Error(`EACCES: permission denied (injected), open '${file}'`), {
        code: "EACCES",
      });
    }
    const handle = (await realOpen.apply(this, args)) as { read: ReadFn };
    if (!kind) return handle;
    if (kind === "transcript") tally.transcriptOpens += 1;
    else tally.sidecarOpens += 1;
    const read = handle.read;
    // An own property on this one handle, so nothing outside the fixture root
    // is touched and the prototype every other handle uses stays original.
    handle.read = async function (this: unknown, ...readArgs: unknown[]) {
      const result = await read.apply(handle, readArgs);
      tally.readCalls += 1;
      if (kind === "transcript") tally.transcriptReadBytes += result.bytesRead;
      else tally.sidecarReadBytes += result.bytesRead;
      return result;
    };
    return handle;
  };
  const observedLstat: LstatFn = async function (this: unknown, ...args: unknown[]) {
    if (classify(toPath(args[0]))) tally.lstatCalls += 1;
    return realLstat.apply(this, args);
  };

  target.open = observedOpen;
  target.lstat = observedLstat;
  syncBuiltinESMExports();
  installedOpen = observedOpen;
  restoreHooks = () => {
    target.open = realOpen;
    target.lstat = realLstat;
    syncBuiltinESMExports();
  };
}

export function uninstallFsObserver(): void {
  restoreHooks?.();
  restoreHooks = null;
  installedOpen = null;
  observedRoot = null;
  injectedFaults.clear();
}

/** 0 while the named `fs/promises` binding both readers import is the observer's wrapper. */
export function fsObserverHookMisses(): number {
  return installedOpen !== null && (namedOpen as unknown) === installedOpen ? 0 : 1;
}

export function fsMark(): FsTally {
  return { ...tally };
}

export function fsSince(mark: FsTally): FsTally {
  return {
    transcriptOpens: tally.transcriptOpens - mark.transcriptOpens,
    sidecarOpens: tally.sidecarOpens - mark.sidecarOpens,
    transcriptReadBytes: tally.transcriptReadBytes - mark.transcriptReadBytes,
    sidecarReadBytes: tally.sidecarReadBytes - mark.sidecarReadBytes,
    readCalls: tally.readCalls - mark.readCalls,
    lstatCalls: tally.lstatCalls - mark.lstatCalls,
  };
}

/** Make `open` refuse one path with EACCES, identically for both arms. */
export function injectOpenFault(file: string): void {
  injectedFaults.add(file);
}

// --- Fixture store -----------------------------------------------------------

/** Bytes each reader reads from either end of a transcript when listing. */
export const PROBE_WINDOW_BYTES = 128 * 1024;
const ACTIVE_WINDOW_MS = 2 * 60_000;
const LIST_LIMIT = 50;
const WRITE_CONCURRENCY = 8;

/**
 * Transcript sizes, cycled. Every one past twice the probe window has more
 * than a window on each end, so both readers pay a head and a tail read for
 * it; the smallest is read whole. Every sixteenth child is a long one.
 */
const TRANSCRIPT_SIZES = [72 * 1024, 180 * 1024, 300 * 1024, 420 * 1024];
const LONG_TRANSCRIPT_BYTES = 900 * 1024;

type ChildEnding = "ended" | "open" | "bookkeeping" | "partial";

const AGENT_TYPES = [
  { recorded: "general-purpose", shown: "General purpose" },
  { recorded: "Explore", shown: "Explore" },
  { recorded: "code_reviewer", shown: "Code reviewer" },
] as const;

export interface ChildSpec {
  id: string;
  file: string;
  mtimeMs: number;
  size: number;
  ending: ChildEnding;
  prompt: string;
  firstTimestampMs: number;
  sidecar: {
    description: string;
    agentType: string;
    role: string;
    model: string;
    depth: number;
    mtimeMs: number;
  } | null;
}

export interface SessionFixture {
  dir: string;
  children: ChildSpec[];
}

export interface StoreFixture {
  root: string;
  sessions: SessionFixture[];
  /** Status clock for the first sweep; every child's mtime is placed against it. */
  baseNowMs: number;
  transcriptFiles: number;
  transcriptBytes: number;
  largeTranscriptFiles: number;
  sidecarFiles: number;
  sidecarBytes: number;
}

function hex(seed: number, length: number): string {
  let out = "";
  let state = (seed * 2_654_435_761) >>> 0;
  while (out.length < length) {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    out += state.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

const PROMPT_SENTENCES = [
  "Read the palette filter and report every place a stale query can survive a project switch.",
  "Run the focused suite for the worktree sidebar and summarise the failures — don't fix them.",
  "Compare the two branches' handling of the resize path, including the reflow → scroll pin case.",
  "Find callers of the session store that read before hydration and list them with file:line.",
  "Draft a migration note for the settings rename; keep it under ten lines. Ünïcödé stays as is.",
  "Check whether the watcher survives a renamed root, then try the same with a symlinked one 🚀.",
];

/** A delegated task of a few hundred to a few thousand characters, unique to its child. */
function promptFor(seed: number): string {
  const sentences = 3 + (seed % 37);
  const parts = [`Task ${seed}:`];
  for (let index = 0; index < sentences; index += 1) {
    parts.push(PROMPT_SENTENCES[(seed + index) % PROMPT_SENTENCES.length] as string);
  }
  return parts.join(" ");
}

/**
 * Lines of the body every transcript carries between its task and its end:
 * tool calls and tool results the size real ones are, with the mix of
 * structure and prose a child produces. One block, reused across files, so
 * building hundreds of transcripts doesn't regenerate megabytes of JSON.
 */
let fillerCache: { text: Buffer; lineEnds: number[] } | null = null;

function filler(): { text: Buffer; lineEnds: number[] } {
  if (fillerCache) return fillerCache;
  const lines: string[] = [];
  let bytes = 0;
  let index = 0;
  while (bytes < LONG_TRANSCRIPT_BYTES) {
    const at = isoAt(1_760_000_000_000 + index * 1_000);
    const line =
      index % 2 === 0
        ? JSON.stringify({
            type: "assistant",
            isSidechain: true,
            timestamp: at,
            message: {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: `Step ${index}: checking the next file. `.repeat(12),
                },
                {
                  type: "tool_use",
                  id: `toolu_${hex(index, 24)}`,
                  name: index % 4 === 0 ? "Read" : "Grep",
                  input: {
                    file_path: `/Users/perf/project/src/module${index}.ts`,
                    pattern: "useEffect",
                  },
                },
              ],
              stop_reason: "tool_use",
            },
          })
        : JSON.stringify({
            type: "user",
            isSidechain: true,
            timestamp: at,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: `toolu_${hex(index - 1, 24)}`,
                  content:
                    `${index}\texport function handler${index}(event: Event): void {\n`.repeat(
                      40 + (index % 7) * 15
                    ),
                },
              ],
            },
          });
    lines.push(line);
    bytes += Buffer.byteLength(line) + 1;
    index += 1;
  }
  const text = Buffer.from(lines.join("\n") + "\n", "utf8");
  const lineEnds: number[] = [];
  for (let offset = 0; offset < text.length; offset += 1) {
    if (text[offset] === 0x0a) lineEnds.push(offset + 1);
  }
  fillerCache = { text, lineEnds };
  return fillerCache;
}

function tailFor(ending: ChildEnding, atMs: number, seed: number): string {
  const at = isoAt(atMs);
  const done = JSON.stringify({
    type: "assistant",
    isSidechain: true,
    timestamp: at,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: `Finished task ${seed}: three findings, all in the store layer.` },
      ],
      stop_reason: "end_turn",
    },
  });
  switch (ending) {
    case "ended":
      return done + "\n";
    case "bookkeeping":
      return (
        done +
        "\n" +
        JSON.stringify({
          type: "attachment",
          timestamp: at,
          attachment: { type: "hook_success" },
        }) +
        "\n"
      );
    case "open":
      return (
        JSON.stringify({
          type: "assistant",
          isSidechain: true,
          timestamp: at,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: `toolu_${hex(seed, 24)}`,
                name: "Bash",
                input: { command: "npm test" },
              },
            ],
            stop_reason: "tool_use",
          },
        }) + "\n"
      );
    case "partial":
      // A record mid-write: no closing brace and no newline yet.
      return done + "\n" + done.slice(0, Math.floor(done.length / 2));
  }
}

/** The transcript bytes for one child, at exactly `size` or the nearest line boundary below it. */
function transcriptBytes(spec: Omit<ChildSpec, "file" | "size">, size: number): Buffer {
  const first = Buffer.from(
    JSON.stringify({
      type: "user",
      isSidechain: true,
      timestamp: isoAt(spec.firstTimestampMs),
      message: { role: "user", content: spec.prompt },
    }) + "\n",
    "utf8"
  );
  const tail = Buffer.from(
    tailFor(spec.ending, spec.mtimeMs, Number.parseInt(spec.id.slice(1, 9), 16)),
    "utf8"
  );
  const { text, lineEnds } = filler();
  const room = size - first.length - tail.length;
  let take = 0;
  for (const end of lineEnds) {
    if (end > room) break;
    take = end;
  }
  return Buffer.concat([first, text.subarray(0, take), tail]);
}

function sidecarBytes(sidecar: NonNullable<ChildSpec["sidecar"]>, seed: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      agentType: sidecar.agentType,
      description: sidecar.description,
      model: sidecar.model,
      spawnDepth: sidecar.depth,
      toolUseId: `toolu_${hex(seed, 24)}`,
      parentUuid: `${hex(seed + 1, 8)}-${hex(seed + 2, 4)}-${hex(seed + 3, 4)}-${hex(seed + 4, 4)}-${hex(seed + 5, 12)}`,
    }),
    "utf8"
  );
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor] as T;
        cursor += 1;
        await fn(item);
      }
    })
  );
}

export async function writeChildFiles(spec: ChildSpec, seed: number): Promise<void> {
  const body = transcriptBytes(spec, spec.size);
  await fsp.writeFile(spec.file, body);
  spec.size = body.length;
  const mtime = new Date(spec.mtimeMs);
  await fsp.utimes(spec.file, mtime, mtime);
  if (spec.sidecar) {
    const meta = spec.file.replace(/\.jsonl$/, ".meta.json");
    await fsp.writeFile(meta, sidecarBytes(spec.sidecar, seed));
    const born = new Date(spec.sidecar.mtimeMs);
    await fsp.utimes(meta, born, born);
  }
}

export function specChild(
  dir: string,
  seed: number,
  mtimeMs: number,
  ending: ChildEnding,
  withSidecar: boolean,
  size: number
): ChildSpec {
  const id = `a${hex(seed, 16)}`;
  const type = AGENT_TYPES[seed % AGENT_TYPES.length] ?? AGENT_TYPES[0];
  return {
    id,
    file: path.join(dir, `agent-${id}.jsonl`),
    mtimeMs,
    size,
    ending,
    prompt: promptFor(seed),
    firstTimestampMs: mtimeMs - 600_000,
    sidecar: withSidecar
      ? {
          description: `Subtask ${seed} of the delegated review`,
          agentType: type.recorded,
          role: type.shown,
          model: seed % 3 === 0 ? "claude-haiku-5-5" : "claude-sonnet-5-5",
          depth: 1 + (seed % 2),
          mtimeMs: mtimeMs - 590_000,
        }
      : null,
  };
}

const ENDINGS: readonly ChildEnding[] = ["ended", "open", "bookkeeping", "partial"];

/**
 * Children are placed against `baseNowMs` in whole seconds: the first three
 * of every session inside the two-minute active window, the rest hours back,
 * so both sides of the status rule are on screen. Endings and sidecar
 * presence cycle so every row shape appears in every session.
 */
export async function buildClaudeSubagentStore(
  sessionCount: number,
  childrenPerSession: number
): Promise<StoreFixture> {
  const root = createPerfTempRoot("daintree-perf-claude-subagents-", { canonical: true });
  const baseNowMs = Math.floor(Date.now() / 1000) * 1000;
  const sessions: SessionFixture[] = [];
  const all: Array<{ spec: ChildSpec; seed: number }> = [];

  for (let s = 0; s < sessionCount; s += 1) {
    const dir = path.join(
      root,
      "projects",
      `-Users-perf-Projects-app${s}`,
      `${hex(s * 7 + 1, 8)}-${hex(s * 7 + 2, 4)}-${hex(s * 7 + 3, 4)}-${hex(s * 7 + 4, 4)}-${hex(s * 7 + 5, 12)}`,
      "subagents"
    );
    await fsp.mkdir(dir, { recursive: true });
    const children: ChildSpec[] = [];
    for (let c = 0; c < childrenPerSession; c += 1) {
      const seed = s * 100_003 + c + 1;
      const offsetSeconds = c < 3 ? 15 + c * 30 : 3_600 + c * 97;
      const size =
        c % 16 === 15
          ? LONG_TRANSCRIPT_BYTES
          : (TRANSCRIPT_SIZES[c % TRANSCRIPT_SIZES.length] as number);
      const spec = specChild(
        dir,
        seed,
        baseNowMs - offsetSeconds * 1000,
        ENDINGS[c % ENDINGS.length] as ChildEnding,
        c % 9 !== 5,
        size
      );
      children.push(spec);
      all.push({ spec, seed });
    }
    sessions.push({ dir, children });
  }

  await pool(all, WRITE_CONCURRENCY, ({ spec, seed }) => writeChildFiles(spec, seed));

  let transcriptBytesTotal = 0;
  let large = 0;
  let sidecars = 0;
  let sidecarBytesTotal = 0;
  for (const { spec, seed } of all) {
    transcriptBytesTotal += spec.size;
    if (spec.size > 2 * PROBE_WINDOW_BYTES) large += 1;
    if (spec.sidecar) {
      sidecars += 1;
      sidecarBytesTotal += sidecarBytes(spec.sidecar, seed).length;
    }
  }
  return {
    root,
    sessions,
    baseNowMs,
    transcriptFiles: all.length,
    transcriptBytes: transcriptBytesTotal,
    largeTranscriptFiles: large,
    sidecarFiles: sidecars,
    sidecarBytes: sidecarBytesTotal,
  };
}

/** 0 when every transcript and sidecar on disk is the size and time the fixture recorded. */
export async function fixtureMisses(store: StoreFixture): Promise<number> {
  let misses = 0;
  for (const session of store.sessions) {
    for (const child of session.children) {
      try {
        const stats = await fsp.lstat(child.file);
        if (
          !stats.isFile() ||
          stats.size !== child.size ||
          Math.round(stats.mtimeMs) !== child.mtimeMs
        ) {
          misses += 1;
        }
      } catch {
        misses += 1;
      }
    }
  }
  return misses;
}

export function releaseClaudeSubagentStore(store: StoreFixture): void {
  releasePerfTempRoot(store.root);
}

// --- Expected rows -----------------------------------------------------------

/**
 * What a list of `session` must return at `nowMs`, from the fixture's own
 * record of what it wrote rather than from either reader. Comparing the two
 * readers alone would let two empty implementations agree.
 */
export function expectedRows(
  children: ChildSpec[],
  nowMs: number,
  exclude: ReadonlySet<string> = new Set()
): AgentSubagent[] {
  return children
    .filter((child) => !exclude.has(child.id))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id))
    .slice(0, LIST_LIMIT)
    .map((child) => {
      const recent = nowMs - child.mtimeMs <= ACTIVE_WINDOW_MS;
      const status: AgentSubagent["status"] =
        child.ending === "ended" || child.ending === "bookkeeping"
          ? { type: "completed" }
          : recent
            ? { type: "working" }
            : { type: "unknown", reason: "stale" };
      return {
        id: child.id,
        label: child.sidecar?.description ?? null,
        role: child.sidecar?.role ?? null,
        preview: child.prompt.slice(0, 4000),
        model: child.sidecar?.model ?? null,
        depth: child.sidecar?.depth ?? null,
        status,
        createdAt: child.sidecar?.mtimeMs ?? child.firstTimestampMs,
        updatedAt: child.mtimeMs,
      };
    });
}

/** Rows that differ between two lists, plus any difference in length. */
export function rowDifferences(actual: AgentSubagent[], expected: AgentSubagent[]): number {
  let misses = Math.abs(actual.length - expected.length);
  const shared = Math.min(actual.length, expected.length);
  for (let index = 0; index < shared; index += 1) {
    if (!isDeepStrictEqual(actual[index], expected[index])) misses += 1;
  }
  return misses;
}
