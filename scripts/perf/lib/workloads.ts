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

export interface DevPreviewLogFrame {
  message: string;
  hasUrl: boolean;
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

export function simulateLayoutHydration(layout: PersistedLayout): {
  restoredPanels: number;
  restoredGroups: number;
  checksum: number;
} {
  const indexById = new Map<string, PanelState>();
  let checksum = 0;

  for (const panel of layout.panels) {
    indexById.set(panel.id, panel);
    checksum += panel.id.length + panel.title.length + panel.cwd.length;

    if (panel.command) checksum += panel.command.length;
    if (panel.browserUrl) checksum += panel.browserUrl.length;
  }

  let restoredGroups = 0;
  for (const group of layout.tabGroups) {
    const validTabIds = group.tabIds.filter((tabId) => indexById.has(tabId));
    if (validTabIds.length === 0) continue;

    restoredGroups += 1;
    checksum += validTabIds.length + group.id.length;

    if (!indexById.has(group.activeTabId)) {
      checksum += validTabIds[0].length;
    }
  }

  return {
    restoredPanels: indexById.size,
    restoredGroups,
    checksum,
  };
}

/**
 * What a switch cycle actually built, read back off the structures it produced.
 *
 * Counts, not timings, and cumulative across `iterations`. A cycle reduced to
 * `return { checksum: 0 }` is the fastest one there is and reports none of
 * them, which is what lets the scenarios pair their durations with a miss
 * count instead of trusting a checksum nothing compares.
 */
export interface ProjectSwitchCycleResult {
  checksum: number;
  elapsedMs: number;
  /** Panels that came back out of the hydration index. */
  restoredPanels: number;
  /** Tab groups rebuilt with at least one surviving tab. */
  restoredGroups: number;
  /** Outgoing terminal entries that were built and serialized. */
  serializedTerminals: number;
  /** Bytes of outgoing state actually serialized. */
  serializedBytes: number;
}

export function simulateProjectSwitchCycle(params: {
  outgoingStateSize: number;
  incomingLayout: PersistedLayout;
  iterations?: number;
}): ProjectSwitchCycleResult {
  const start = performance.now();
  let checksum = 0;
  let restoredPanels = 0;
  let restoredGroups = 0;
  let serializedTerminals = 0;
  let serializedBytes = 0;
  const iterations = Math.max(1, params.iterations ?? 1);

  for (let i = 0; i < iterations; i += 1) {
    const outgoingState = {
      activeWorktreeId: `wt-${(i % 5) + 1}`,
      sidebarWidth: 280 + (i % 6) * 10,
      terminals: Array.from({ length: params.outgoingStateSize }, (_, index) => ({
        id: `term-${i}-${index}`,
        cwd: `/repo/switch/${index}`,
        title: `Terminal ${index}`,
      })),
    };

    const payload = JSON.stringify(outgoingState);
    checksum += payload.length;
    serializedTerminals += outgoingState.terminals.length;
    serializedBytes += payload.length;

    const hydrated = simulateLayoutHydration(params.incomingLayout);
    checksum += hydrated.checksum;
    restoredPanels += hydrated.restoredPanels;
    restoredGroups += hydrated.restoredGroups;
  }

  return {
    checksum,
    elapsedMs: performance.now() - start,
    restoredPanels,
    restoredGroups,
    serializedTerminals,
    serializedBytes,
  };
}

/**
 * Post-conditions of a switch cycle, checked against what it produced.
 *
 * The expectations come from the layout that went in and the outgoing size it
 * was asked for, so nothing inside `simulateProjectSwitchCycle` can satisfy
 * them without rebuilding the hydration index and serializing the outgoing
 * state — the two pieces of work the scenario is timing.
 */
export function projectSwitchCycleMisses(
  expected: { incomingLayout: PersistedLayout; outgoingStateSize: number; iterations?: number },
  result: ProjectSwitchCycleResult
): number {
  const iterations = Math.max(1, expected.iterations ?? 1);
  return (
    Math.abs(expected.incomingLayout.panels.length * iterations - result.restoredPanels) +
    Math.abs(expected.incomingLayout.tabGroups.length * iterations - result.restoredGroups) +
    Math.abs(expected.outgoingStateSize * iterations - result.serializedTerminals) +
    (result.serializedBytes > 0 ? 0 : 1)
  );
}

export interface ProjectSwitchPhaseResult {
  checksum: number;
  /**
   * What each phase left behind, read back off the structures themselves.
   *
   * Every phase below is timed and reports only a duration, so a phase reduced
   * to a no-op posts the best number the harness has recorded. These counts are
   * what a skipped phase cannot post.
   */
  produced: {
    /** Outgoing terminal entries built and serialized (phase 1). */
    serializedTerminals: number;
    /** Entries in the hibernation map (phase 2). */
    hibernatedTerminals: number;
    /** Stores that were filled and cleared (phase 3). */
    resetStores: number;
    /** Panels in the rebuilt panel index (phase 4). */
    indexedPanels: number;
    /** Panels the hydration restored (phase 5). */
    restoredPanels: number;
    /** Tab groups the hydration rebuilt (phase 5). */
    restoredGroups: number;
    /** PTY descriptors allocated (phase 6). */
    ptyDescriptors: number;
    /** File status entries aggregated (phase 7). */
    fileStatuses: number;
  };
  phases: {
    serializeMs: number;
    ptyHibernateMs: number;
    storeResetMs: number;
    projectLoadMs: number;
    terminalRestoreMs: number;
    ptyWarmupMs: number;
    gitFetchMs: number;
    totalMs: number;
    /**
     * Time until the incoming view would be visible to the user (skeleton
     * painted). With the decoupled cold-switch path this is when
     * `ProjectViewManager` swaps the outgoing view for the incoming one.
     * Modeled as the sum of phases 1-4 (serialize + pty hibernate + store
     * reset + project load) since terminal restore / pty warmup / git fetch
     * are post-visible hydration.
     */
    visibleMs: number;
    /**
     * Time until full data hydration completes (terminal restore, pty
     * warmup, git fetch). Equal to `totalMs` — the alias exists so dashboards
     * can plot visible-vs-hydrate latency without referencing two metric
     * names with different semantics across scenarios.
     */
    hydrateMs: number;
  };
}

export function simulateProjectSwitchPhased(params: {
  outgoingStateSize: number;
  incomingLayout: PersistedLayout;
}): ProjectSwitchPhaseResult {
  const totalStart = performance.now();
  let checksum = 0;

  // Phase 1: Serialize outgoing state (JSON.stringify — dominant cost)
  const serializeStart = performance.now();
  const outgoingState = {
    activeWorktreeId: "wt-1",
    sidebarWidth: 280,
    terminals: Array.from({ length: params.outgoingStateSize }, (_, index) => ({
      id: `term-${index}`,
      cwd: `/repo/switch/${index}`,
      title: `Terminal ${index}`,
      scrollback: `line-data-${index}-${"x".repeat(64)}`,
    })),
  };
  const payload = JSON.stringify(outgoingState);
  checksum += payload.length;
  const serializeMs = Math.max(0, performance.now() - serializeStart);

  // Phase 2: PTY hibernate (object mapping)
  const ptyHibernateStart = performance.now();
  const hibernated = new Map<string, { id: string; cwd: string }>();
  for (const term of outgoingState.terminals) {
    hibernated.set(term.id, { id: term.id, cwd: term.cwd });
  }
  checksum += hibernated.size;
  const ptyHibernateMs = Math.max(0, performance.now() - ptyHibernateStart);

  // Phase 3: Store reset (clear maps + arrays)
  const storeResetStart = performance.now();
  const stores = Array.from({ length: 17 }, () => new Map<string, unknown>());
  for (const store of stores) {
    for (let i = 0; i < params.outgoingStateSize; i++) {
      store.set(`key-${i}`, { value: i });
    }
    store.clear();
  }
  checksum += stores.length;
  const storeResetMs = Math.max(0, performance.now() - storeResetStart);

  // Phase 4: Project load (JSON.parse + index build)
  const projectLoadStart = performance.now();
  const projectData = JSON.parse(JSON.stringify(params.incomingLayout));
  const panelIndex = new Map<string, PanelState>();
  for (const panel of projectData.panels as PanelState[]) {
    panelIndex.set(panel.id, panel);
  }
  checksum += panelIndex.size;
  const projectLoadMs = Math.max(0, performance.now() - projectLoadStart);

  // Phase 5: Terminal restore (hydration + tab group rebuild)
  const terminalRestoreStart = performance.now();
  const hydrated = simulateLayoutHydration(params.incomingLayout);
  checksum += hydrated.checksum;
  const terminalRestoreMs = Math.max(0, performance.now() - terminalRestoreStart);

  // Phase 6: PTY warmup (descriptor allocation)
  const ptyWarmupStart = performance.now();
  const descriptors = new Array(params.incomingLayout.panels.length);
  for (let i = 0; i < descriptors.length; i++) {
    descriptors[i] = { fd: i, pid: 1000 + i };
  }
  checksum += descriptors.length;
  const ptyWarmupMs = Math.max(0, performance.now() - ptyWarmupStart);

  // Phase 7: Git status fetch (file status aggregation)
  const gitFetchStart = performance.now();
  const fileStatuses = new Map<string, string>();
  for (const wt of params.incomingLayout.worktrees) {
    for (let j = 0; j < 10; j++) {
      fileStatuses.set(`${wt}/file-${j}.ts`, j % 3 === 0 ? "modified" : "clean");
    }
  }
  checksum += fileStatuses.size;
  const gitFetchMs = Math.max(0, performance.now() - gitFetchStart);

  const totalMs = Math.max(0, performance.now() - totalStart);
  const visibleMs = serializeMs + ptyHibernateMs + storeResetMs + projectLoadMs;

  return {
    checksum,
    produced: {
      serializedTerminals: outgoingState.terminals.length,
      hibernatedTerminals: hibernated.size,
      resetStores: stores.length,
      indexedPanels: panelIndex.size,
      restoredPanels: hydrated.restoredPanels,
      restoredGroups: hydrated.restoredGroups,
      ptyDescriptors: descriptors.length,
      fileStatuses: fileStatuses.size,
    },
    phases: {
      serializeMs,
      ptyHibernateMs,
      storeResetMs,
      projectLoadMs,
      terminalRestoreMs,
      ptyWarmupMs,
      gitFetchMs,
      totalMs,
      visibleMs,
      hydrateMs: totalMs,
    },
  };
}

/**
 * Post-conditions of a phased switch, one per phase that produces something.
 *
 * Derived from the layout and outgoing size that went in, so a phase that
 * stopped doing its work scores here rather than reporting its best-ever
 * duration. Phases 1-7 map onto the seven terms below in order.
 */
export function projectSwitchPhaseMisses(
  expected: { incomingLayout: PersistedLayout; outgoingStateSize: number },
  result: ProjectSwitchPhaseResult
): number {
  const layout = expected.incomingLayout;
  const produced = result.produced;
  return (
    Math.abs(expected.outgoingStateSize - produced.serializedTerminals) +
    Math.abs(expected.outgoingStateSize - produced.hibernatedTerminals) +
    (produced.resetStores > 0 ? 0 : 1) +
    Math.abs(layout.panels.length - produced.indexedPanels) +
    Math.abs(layout.panels.length - produced.restoredPanels) +
    Math.abs(layout.tabGroups.length - produced.restoredGroups) +
    Math.abs(layout.panels.length - produced.ptyDescriptors) +
    Math.abs(layout.worktrees.length * 10 - produced.fileStatuses)
  );
}

export function createDevPreviewLogFrames(frameCount: number, noisy = false): DevPreviewLogFrame[] {
  const frames: DevPreviewLogFrame[] = [];

  for (let i = 0; i < frameCount; i += 1) {
    const hasUrl = i === Math.floor(frameCount * 0.6);
    if (hasUrl) {
      frames.push({
        message: `server ready in ${1200 + i}ms\nLocal: http://localhost:${3000 + (i % 20)}`,
        hasUrl: true,
      });
      continue;
    }

    const noise = noisy
      ? `webpack chunk=${i} hash=${Math.random().toString(36).slice(2)} elapsed=${i * 13}ms`
      : `build step ${i}`;

    frames.push({
      message: `${noise}\n`,
      hasUrl: false,
    });
  }

  return frames;
}

export function detectLatestLocalhostUrl(frames: readonly DevPreviewLogFrame[]): string | null {
  let lastUrl: string | null = null;
  const regex = /https?:\/\/localhost:\d{2,5}(?:\/[^\s]*)?/gi;

  for (const frame of frames) {
    const matches = frame.message.match(regex);
    if (matches && matches.length > 0) {
      lastUrl = matches[matches.length - 1];
    }
  }

  return lastUrl;
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
