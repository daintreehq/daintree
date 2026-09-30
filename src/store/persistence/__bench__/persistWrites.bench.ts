// @vitest-environment jsdom
import { bench, describe } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { setWorktreeGitDirAccessor } from "@/store/storeAccessors";
import type { TerminalInstance } from "@/types";
import { PanelPersistence } from "../panelPersistence";
import { createSafeJSONStorage } from "../safeStorage";
import { mergeRecordByWriterDelta, type PersistWriteMerge } from "../persistWriteMerge";

// Run with: npx vitest bench --run src/store/persistence/__bench__/persistWrites.bench.ts

// Vitest bench swallows console output; write the counters straight to stderr.
const report = (label: string, value: unknown): void => {
  process.stderr.write(`[persistWrites] ${label}: ${JSON.stringify(value)}\n`);
};

const counts = { getItem: 0, setItem: 0, backup: 0 };
const backing = new Map<string, string>();
const spyStorage: StateStorage = {
  getItem: (key) => {
    counts.getItem += 1;
    return backing.get(key) ?? null;
  },
  setItem: (key, value) => {
    if (key.endsWith(".__bak")) counts.backup += 1;
    else counts.setItem += 1;
    backing.set(key, value);
  },
  removeItem: (key) => {
    backing.delete(key);
  },
};
Object.defineProperty(globalThis, "localStorage", { value: spyStorage, configurable: true });

type Notes = { notes: Record<string, { body: string; line: number; updatedAt: number }> };
const mergeNotes: PersistWriteMerge<Notes> = ({ baseline, onDisk, incoming }) => {
  if (!onDisk) return incoming;
  return {
    version: incoming.version,
    state: {
      notes: mergeRecordByWriterDelta(
        baseline?.state.notes ?? {},
        incoming.state.notes,
        onDisk.state.notes ?? {}
      ),
    },
  };
};
const notes: Notes["notes"] = {};
for (let i = 0; i < 50; i += 1) {
  notes[`src/file-${i}.ts:${i}`] = { body: "x".repeat(120), line: i, updatedAt: 1_700_000_000 + i };
}
const unchangedWrite = { state: { notes }, version: 1 };

function runIdenticalMergeWrites(): typeof counts {
  const storage = createSafeJSONStorage<Notes>({ mergeOnWrite: mergeNotes });
  storage.getItem("bench-notes");
  counts.getItem = 0;
  counts.setItem = 0;
  counts.backup = 0;
  for (let i = 0; i < 1000; i += 1) storage.setItem("bench-notes", unchangedWrite);
  return { ...counts };
}

report("1000 identical mergeOnWrite setItem calls", runIdenticalMergeWrites());

describe("safeStorage mergeOnWrite", () => {
  bench("1000 identical setItem calls (~10KB state)", () => {
    runIdenticalMergeWrites();
  });
});

initBuiltInPanelKinds();
setWorktreeGitDirAccessor((worktreeId) => `/repo/.git/worktrees/${worktreeId}`);

function makePanels(): TerminalInstance[] {
  const panels: TerminalInstance[] = [];
  for (let i = 0; i < 40; i += 1) {
    const base = {
      id: `panel-${i}`,
      title: `Panel ${i}`,
      worktreeId: `wt-${i % 4}`,
      location: "grid" as const,
      createdAt: 1_700_000_000_000 + i,
      lastActiveAt: 1_700_000_100_000 + i,
    };
    switch (i % 5) {
      case 0:
      case 1:
        panels.push({
          ...base,
          kind: "terminal",
          cwd: `/repo/wt-${i % 4}`,
          command: "claude --model opus",
          launchAgentId: "claude",
          agentState: "idle",
          lastStateChange: 1_700_000_200_000,
          env: { FOO: "bar", BAZ: "qux" },
          agentLaunchFlags: ["--verbose"],
          cols: 120,
          rows: 40,
        } as TerminalInstance);
        break;
      case 2:
        panels.push({
          ...base,
          kind: "browser",
          browserUrl: `http://localhost:${3000 + i}/`,
          browserHistory: {
            past: Array.from({ length: 20 }, (_, n) => `http://localhost:${3000 + i}/p/${n}`),
            present: `http://localhost:${3000 + i}/`,
            future: [],
          },
          browserZoom: 1,
        } as unknown as TerminalInstance);
        break;
      case 3:
        panels.push({
          ...base,
          kind: "file-browser",
          browserRootPath: `/repo/wt-${i % 4}`,
          browserExpandedPaths: Array.from({ length: 30 }, (_, n) => `/repo/src/dir-${n}`),
          browserSelectedPath: "/repo/src/dir-3/index.ts",
        } as unknown as TerminalInstance);
        break;
      default:
        panels.push({
          ...base,
          kind: "dev-preview",
          cwd: `/repo/wt-${i % 4}`,
          command: "npm run dev",
          browserUrl: "http://localhost:5173/",
        } as unknown as TerminalInstance);
    }
  }
  return panels;
}

const projectId = "bench-project";
const noopClient = {
  setTerminals: async () => {},
  setTabGroups: async () => {},
} as unknown as ConstructorParameters<typeof PanelPersistence>[0];

function makePersistence(panels: TerminalInstance[]): PanelPersistence {
  const persistence = new PanelPersistence(noopClient, { debounceMs: 60_000 });
  persistence.save(panels, projectId);
  return persistence;
}

// Snapshots the save produced that are not reference-identical to the previous
// save's — i.e. per-panel snapshot objects that were rebuilt.
function rebuiltSnapshots(persistence: PanelPersistence, before: Map<string, unknown>): number {
  const after = persistence.getPreviousSnapshotMap(projectId);
  let rebuilt = 0;
  for (const [id, snap] of after ?? []) if (before.get(id) !== snap) rebuilt += 1;
  return rebuilt;
}

const noopPanels = makePanels();
const noopPersistence = makePersistence(noopPanels);

// Like a store update: a fresh array holding one fresh panel object, so every
// iteration pays for rebuilding the changed panel's snapshot.
function withChangedPanel(
  panels: TerminalInstance[],
  index: number,
  patch: Partial<TerminalInstance>
): TerminalInstance[] {
  const next = panels.slice();
  next[index] = { ...panels[index]!, ...patch } as TerminalInstance;
  return next;
}

const titlePanels = makePanels();
const titlePersistence = makePersistence(titlePanels);
let titleTick = 0;

const urlPanels = makePanels();
const urlPersistence = makePersistence(urlPanels);
let urlTick = 0;

{
  const panels = makePanels();
  const probe = makePersistence(panels);
  const before = new Map(probe.getPreviousSnapshotMap(projectId) ?? []);
  probe.save(
    panels.map((p, i) => (i === 5 ? { ...p, title: "probe" } : p)),
    projectId
  );
  report("snapshots rebuilt for a one-title change", rebuiltSnapshots(probe, before));
}

describe("panelPersistence.save (40 mixed panels)", () => {
  bench("no-op save", () => {
    noopPersistence.save(noopPanels, projectId);
  });
  bench("one-title change", () => {
    titleTick += 1;
    titlePersistence.save(
      withChangedPanel(titlePanels, 5, { title: `Renamed ${titleTick % 2}` }),
      projectId
    );
  });
  bench("browserUrl change", () => {
    urlTick += 1;
    urlPersistence.save(
      withChangedPanel(urlPanels, 7, {
        browserUrl: `http://localhost/n${urlTick % 2}`,
      } as Partial<TerminalInstance>),
      projectId
    );
  });
});
