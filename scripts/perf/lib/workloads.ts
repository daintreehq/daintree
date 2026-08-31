import { performance } from "node:perf_hooks";
import { applyXtermReflowFastpath } from "../../../shared/utils/xtermReflowFastpath";

export interface PanelState {
  id: string;
  kind: "terminal" | "agent" | "browser" | "dev-preview";
  worktreeId: string | null;
  title: string;
  cwd: string;
  command?: string;
  browserUrl?: string;
}

export interface PersistedLayout {
  panels: PanelState[];
  tabGroups: Array<{ id: string; tabIds: string[]; activeTabId: string }>;
  worktrees: string[];
}

const KIND_SEQUENCE: PanelState["kind"][] = ["terminal", "agent", "browser", "dev-preview"];

export function createRng(seed = 1337): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

function randomChoice<T>(items: readonly T[], rng: () => number): T {
  const index = Math.floor(rng() * items.length);
  return items[Math.min(index, items.length - 1)];
}

function randomToken(rng: () => number, length = 8): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const idx = Math.floor(rng() * alphabet.length);
    out += alphabet[idx];
  }
  return out;
}

export function createPersistedLayout(
  panelCount: number,
  worktreeCount: number,
  rngSeed = 1337
): PersistedLayout {
  const rng = createRng(rngSeed);
  const worktrees = Array.from({ length: worktreeCount }, (_, index) => `wt-${index + 1}`);

  const panels: PanelState[] = Array.from({ length: panelCount }, (_, index) => {
    const kind = randomChoice(KIND_SEQUENCE, rng);
    const worktreeId = worktrees[Math.floor(rng() * worktrees.length)] ?? null;
    const id = `${kind}-${index}-${randomToken(rng, 6)}`;

    return {
      id,
      kind,
      worktreeId,
      title: `${kind.toUpperCase()} ${index}`,
      cwd: `/repo/${worktreeId ?? "main"}`,
      command:
        kind === "terminal" || kind === "agent" || kind === "dev-preview"
          ? `cmd-${index}-${randomToken(rng, 4)}`
          : undefined,
      browserUrl:
        kind === "browser" || kind === "dev-preview"
          ? `http://localhost:${3000 + (index % 20)}`
          : undefined,
    };
  });

  const groups: PersistedLayout["tabGroups"] = [];
  const groupSize = Math.max(2, Math.floor(panelCount / Math.max(1, worktreeCount * 2)));

  for (let start = 0; start < panels.length; start += groupSize) {
    const slice = panels.slice(start, start + groupSize);
    if (slice.length === 0) continue;
    groups.push({
      id: `group-${groups.length + 1}`,
      tabIds: slice.map((panel) => panel.id),
      activeTabId: slice[slice.length - 1].id,
    });
  }

  return {
    panels,
    tabGroups: groups,
    worktrees,
  };
}

/**
 * The four project-switch phases that genuinely cannot run in this process.
 *
 * THIS IS A SIMULATION, and it is one deliberately. Every other phase of a
 * switch is now driven through the real product code — the outgoing delta and
 * the three-way merge via `lib/layoutMergeFixture.ts`, the per-panel restore
 * decisions via `lib/hydrationFixture.ts`, the worktree re-scope via
 * `lib/worktreeScopeFixture.ts`. These four are what is left, and each one is a
 * stand-in of a known and stated shape:
 *
 * - PTY hibernate. The real path asks the pty-host to park every live PTY for
 *   the outgoing project over the MessagePort, and the cost is the host's
 *   bookkeeping plus the IPC round trip — neither of which exists here. What
 *   runs below is a `Map.set` per terminal.
 * - Store reset. The real path resets ~108 Zustand stores through
 *   `resetProjectScopedStores`, each firing its own subscriber fan-out into
 *   React. There is no React here, so what runs below is a fill-and-clear over
 *   17 plain Maps and prices none of the notification cost.
 * - PTY warmup. The real path spawns processes through the pty-host. What runs
 *   below allocates descriptor-shaped objects.
 * - Git status fetch. The real path spawns `git status` per worktree through
 *   the workspace host (measured for real by PERF-100..104 and PERF-130..141).
 *   What runs below fills a Map.
 *
 * The durations these report are therefore floors of the wrong shape, not
 * measurements, and the counts are the only readings worth anything — which is
 * why each one is graded by {@link unreachablePhaseMisses}. They are kept
 * because dropping them would silently shorten the switch the phased scenarios
 * describe; they are labelled because the previous version of this file
 * presented the same loops as "the project switch".
 */
export interface UnreachableSwitchPhases {
  checksum: number;
  /** Entries in the hibernation map. */
  hibernatedTerminals: number;
  /** Stores that were filled and cleared. */
  resetStores: number;
  /** PTY descriptors allocated. */
  ptyDescriptors: number;
  /** File status entries aggregated. */
  fileStatuses: number;
  ptyHibernateMs: number;
  storeResetMs: number;
  ptyWarmupMs: number;
  gitFetchMs: number;
}

export function simulateUnreachableSwitchPhases(params: {
  outgoingTerminalCount: number;
  incomingPanelCount: number;
  worktreeCount: number;
}): UnreachableSwitchPhases {
  let checksum = 0;

  // Phase: PTY hibernate (object mapping)
  const ptyHibernateStart = performance.now();
  const hibernated = new Map<string, { id: string; cwd: string }>();
  for (let index = 0; index < params.outgoingTerminalCount; index += 1) {
    hibernated.set(`term-${index}`, { id: `term-${index}`, cwd: `/repo/switch/${index}` });
  }
  checksum += hibernated.size;
  const ptyHibernateMs = Math.max(0, performance.now() - ptyHibernateStart);

  // Phase: store reset (clear maps + arrays)
  const storeResetStart = performance.now();
  const stores = Array.from({ length: 17 }, () => new Map<string, unknown>());
  for (const store of stores) {
    for (let i = 0; i < params.outgoingTerminalCount; i++) {
      store.set(`key-${i}`, { value: i });
    }
    store.clear();
  }
  checksum += stores.length;
  const storeResetMs = Math.max(0, performance.now() - storeResetStart);

  // Phase: PTY warmup (descriptor allocation)
  const ptyWarmupStart = performance.now();
  const descriptors = new Array(params.incomingPanelCount);
  for (let i = 0; i < descriptors.length; i++) {
    descriptors[i] = { fd: i, pid: 1000 + i };
  }
  checksum += descriptors.length;
  const ptyWarmupMs = Math.max(0, performance.now() - ptyWarmupStart);

  // Phase: git status fetch (file status aggregation)
  const gitFetchStart = performance.now();
  const fileStatuses = new Map<string, string>();
  for (let w = 0; w < params.worktreeCount; w += 1) {
    for (let j = 0; j < 10; j++) {
      fileStatuses.set(`wt-${w}/file-${j}.ts`, j % 3 === 0 ? "modified" : "clean");
    }
  }
  checksum += fileStatuses.size;
  const gitFetchMs = Math.max(0, performance.now() - gitFetchStart);

  return {
    checksum,
    hibernatedTerminals: hibernated.size,
    resetStores: stores.length,
    ptyDescriptors: descriptors.length,
    fileStatuses: fileStatuses.size,
    ptyHibernateMs,
    storeResetMs,
    ptyWarmupMs,
    gitFetchMs,
  };
}

/**
 * One term per simulated phase, derived from the sizes each was asked for.
 *
 * These phases report only durations, and a phase reduced to a no-op posts the
 * best duration the harness has ever recorded — which is the whole reason the
 * counts above exist.
 */
export function unreachablePhaseMisses(
  expected: { outgoingTerminalCount: number; incomingPanelCount: number; worktreeCount: number },
  result: UnreachableSwitchPhases
): {
  hibernateMisses: number;
  storeResetMisses: number;
  ptyWarmupMisses: number;
  gitFetchMisses: number;
} {
  return {
    hibernateMisses: Math.abs(expected.outgoingTerminalCount - result.hibernatedTerminals),
    storeResetMisses: result.resetStores > 0 ? 0 : 1,
    ptyWarmupMisses: Math.abs(expected.incomingPanelCount - result.ptyDescriptors),
    gitFetchMisses: Math.abs(expected.worktreeCount * 10 - result.fileStatuses),
  };
}

export interface TerminalOutputPassResult {
  renderedBytes: number;
  retainedBytes: number;
  checksum: number;
  /** Chunks the pass actually walked. */
  consumedChunks: number;
  /** Lines left in the scrollback ring once the pass finished. */
  retainedLineCount: number;
}

export function simulateTerminalOutputPass(
  chunks: readonly string[],
  retainedLines: number
): TerminalOutputPassResult {
  const ring: string[] = [];
  let renderedBytes = 0;
  let checksum = 0;
  let consumedChunks = 0;

  for (const chunk of chunks) {
    renderedBytes += chunk.length;
    checksum += chunk.charCodeAt(0) ?? 0;
    consumedChunks += 1;

    const lines = chunk.split("\n");
    for (const line of lines) {
      if (!line) continue;
      ring.push(line);
      if (ring.length > retainedLines) {
        ring.shift();
      }
    }
  }

  const retainedBytes = ring.reduce((sum, line) => sum + line.length, 0);
  checksum += retainedBytes;

  return {
    renderedBytes,
    retainedBytes,
    checksum,
    consumedChunks,
    retainedLineCount: ring.length,
  };
}

/**
 * Generated chunks carrying their own byte total.
 *
 * The total is the oracle's half of the comparison, so it comes from the
 * generator — the one thing in the picture that is not the subject — and is
 * accumulated as the chunks are built rather than re-summed afterwards.
 */
export interface TerminalChunkStream {
  chunks: string[];
  totalBytes: number;
}

/**
 * Post-conditions of an output pass, checked against the stream it was handed.
 *
 * A pass reduced to `return { renderedBytes: 0 }` is instant and reports the
 * best `renderedBytes`/`checksum` the harness would ever record; it scores every
 * term here. The expected byte total rides in on the stream, and the ring depth
 * is the scrollback rule applied independently of the ring —
 * `makeTerminalStream` puts exactly one line in each chunk, which is what makes
 * the expected depth `min(chunks, cap)`.
 *
 * Every term is O(1): the scenarios wall-clock the whole `run()`, so an oracle
 * that walked the chunks again — to re-`split()` them or merely to re-sum their
 * lengths — would report its own traversal as terminal throughput.
 */
export function terminalOutputPassMisses(
  stream: TerminalChunkStream,
  retainedLines: number,
  result: TerminalOutputPassResult
): number {
  const chunkCount = stream.chunks.length;
  return (
    Math.abs(chunkCount - result.consumedChunks) +
    (stream.totalBytes === result.renderedBytes ? 0 : 1) +
    Math.abs(Math.min(chunkCount, retainedLines) - result.retainedLineCount)
  );
}

export function makeTerminalStream(count: number, avgLength = 120): TerminalChunkStream {
  const rng = createRng(424242 + count + avgLength);
  const chunks: string[] = [];
  let totalBytes = 0;

  for (let i = 0; i < count; i += 1) {
    const len = Math.max(24, Math.floor(avgLength * (0.7 + rng() * 0.6)));
    const chunk = `${randomToken(rng, len)}\n`;
    chunks.push(chunk);
    totalBytes += chunk.length;
  }

  return { chunks, totalBytes };
}

export function makeTerminalChunks(count: number, avgLength = 120): string[] {
  return makeTerminalStream(count, avgLength).chunks;
}

export interface LargeStateSnapshot {
  appState: {
    activeWorktreeId: string | null;
    sidebarWidth: number;
    focusMode: boolean;
    panelGridConfig: { columns: number; rows: number };
    terminals: PanelState[];
  };
  worktreeState: Array<{ id: string; branch: string; path: string; status: string }>;
  tabGroups: PersistedLayout["tabGroups"];
  diagnostics: { logs: Array<{ level: string; message: string; timestamp: number }> };
}

export function createLargeStateSnapshot(scale: number): LargeStateSnapshot {
  const panelCount = Math.max(20, scale);
  const layout = createPersistedLayout(
    panelCount,
    Math.max(2, Math.floor(scale / 20)),
    9000 + scale
  );

  return {
    appState: {
      activeWorktreeId: layout.worktrees[0] ?? null,
      sidebarWidth: 360,
      focusMode: false,
      panelGridConfig: {
        columns: 2,
        rows: Math.ceil(layout.panels.length / 2),
      },
      terminals: layout.panels,
    },
    worktreeState: layout.worktrees.map((id, index) => ({
      id,
      branch: index === 0 ? "main" : `feature/perf-${index}`,
      path: `/repo/worktrees/${id}`,
      status: index % 3 === 0 ? "clean" : "dirty",
    })),
    tabGroups: layout.tabGroups,
    diagnostics: {
      logs: Array.from({ length: Math.max(50, scale / 2) }, (_, index) => ({
        level: index % 7 === 0 ? "warn" : "info",
        message: `log entry ${index}`,
        timestamp: Date.now() - index * 25,
      })),
    },
  };
}

/** Returns the microtask turns actually spun, so callers can prove the load ran. */
export async function spinEventLoop(ms: number): Promise<number> {
  const end = performance.now() + ms;
  let turns = 0;
  while (performance.now() < end) {
    await Promise.resolve();
    turns += 1;
  }
  return turns;
}

export interface HeadlessTerminalConfig {
  cols: number;
  rows: number;
  scrollback?: number;
}

/**
 * Constructs a real @xterm/headless Terminal. The headless bundle exposes
 * the parser/buffer path that the real renderer drives — using it here keeps
 * the microbench in the parser cost layer (no DOM, no rAF, no WebGL addon
 * pool). The `tsx` runner resolves the named export from the ESM build.
 *
 * `convertEol: true` mirrors what a PTY-backed renderer gets for free: a
 * real PTY translates `\n` to `\r\n` via termios. Headless has no PTY, so
 * we set the option explicitly — otherwise `\n` advances the cursor down
 * one line WITHOUT returning to column 0, which spirals the cursor and
 * makes representative log-stream writes misbehave.
 *
 * The reflow fastpath is applied exactly as the app applies it at every
 * terminal creation site, so the scenarios measure what production runs.
 * A/B against the unpatched core: DAINTREE_DISABLE_XTERM_REFLOW_FASTPATH=1.
 */
export async function createHeadlessTerminal(
  config: HeadlessTerminalConfig
): Promise<import("@xterm/headless").Terminal> {
  const { Terminal } = await import("@xterm/headless");
  const terminal = new Terminal({
    cols: config.cols,
    rows: config.rows,
    scrollback: config.scrollback ?? 5000,
    allowProposedApi: true,
    convertEol: true,
  });
  applyXtermReflowFastpath(terminal);
  return terminal;
}
