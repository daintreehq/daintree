import { performance } from "node:perf_hooks";

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

export function simulateProjectSwitchCycle(params: {
  outgoingStateSize: number;
  incomingLayout: PersistedLayout;
  iterations?: number;
}): { checksum: number; elapsedMs: number } {
  const start = performance.now();
  let checksum = 0;
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

    const hydrated = simulateLayoutHydration(params.incomingLayout);
    checksum += hydrated.checksum;
  }

  return {
    checksum,
    elapsedMs: performance.now() - start,
  };
}

export interface ProjectSwitchPhaseResult {
  checksum: number;
  phases: {
    serializeMs: number;
    ptyHibernateMs: number;
    storeResetMs: number;
    projectLoadMs: number;
    terminalRestoreMs: number;
    ptyWarmupMs: number;
    gitFetchMs: number;
    totalMs: number;
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

  return {
    checksum,
    phases: {
      serializeMs,
      ptyHibernateMs,
      storeResetMs,
      projectLoadMs,
      terminalRestoreMs,
      ptyWarmupMs,
      gitFetchMs,
      totalMs,
    },
  };
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

export function simulateTerminalOutputPass(
  chunks: readonly string[],
  retainedLines: number
): {
  renderedBytes: number;
  retainedBytes: number;
  checksum: number;
} {
  const ring: string[] = [];
  let renderedBytes = 0;
  let checksum = 0;

  for (const chunk of chunks) {
    renderedBytes += chunk.length;
    checksum += chunk.charCodeAt(0) ?? 0;

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

  return { renderedBytes, retainedBytes, checksum };
}

export function makeTerminalChunks(count: number, avgLength = 120): string[] {
  const rng = createRng(424242 + count + avgLength);
  const chunks: string[] = [];

  for (let i = 0; i < count; i += 1) {
    const len = Math.max(24, Math.floor(avgLength * (0.7 + rng() * 0.6)));
    const payload = randomToken(rng, len);
    chunks.push(`${payload}\n`);
  }

  return chunks;
}

export function createLargeStateSnapshot(scale: number): Record<string, unknown> {
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

export async function spinEventLoop(ms: number): Promise<void> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    await Promise.resolve();
  }
}
