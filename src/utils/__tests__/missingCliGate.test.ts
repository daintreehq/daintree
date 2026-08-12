import { describe, it, expect } from "vitest";
import {
  buildMissingCliRelaunchOptions,
  findEquivalentMissingCliGate,
} from "@/utils/missingCliGate";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";

function gate(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: "gate-1",
    kind: "terminal",
    launchAgentId: "claude",
    title: "Claude",
    cwd: "/repo",
    worktreeId: "wt-1",
    cols: 80,
    rows: 24,
    location: "grid",
    spawnStatus: "missing-cli",
    startedAt: 0,
    isVisible: true,
    ...overrides,
  } as PtyPanelData;
}

function index(panels: PtyPanelData[]): {
  panelsById: Record<string, PanelInstance>;
  panelIds: string[];
} {
  const panelsById: Record<string, PanelInstance> = {};
  for (const panel of panels) panelsById[panel.id] = panel as unknown as PanelInstance;
  return { panelsById, panelIds: panels.map((p) => p.id) };
}

describe("buildMissingCliRelaunchOptions", () => {
  it("carries every launch field the gate captured", () => {
    const options = buildMissingCliRelaunchOptions(
      gate({
        command: "claude --resume",
        titleMode: "custom",
        agentLaunchFlags: ["--verbose"],
        agentModelId: "opus",
        agentPresetId: "fast",
        agentPresetColor: "#ff0000",
        extensionState: { presetEnv: { TOKEN: "secret" } },
        excludeFromPersistence: true,
        removeOnExit: true,
        spawnedBy: "user",
        focusPolicy: "preserve",
      })
    );

    // Asserted as a whole so a field silently dropped from the builder fails
    // here rather than surviving as an untested omission — the exact way
    // `agentPresetColor` and `titleMode` were lost before.
    expect(options).toMatchObject({
      launchAgentId: "claude",
      command: "claude --resume",
      titleMode: "custom",
      cwd: "/repo",
      worktreeId: "wt-1",
      location: "grid",
      agentLaunchFlags: ["--verbose"],
      agentModelId: "opus",
      agentPresetId: "fast",
      agentPresetColor: "#ff0000",
      env: { TOKEN: "secret" },
      excludeFromPersistence: true,
      removeOnExit: true,
      spawnedBy: "user",
      focusPolicy: "preserve",
    });
  });

  it("refuses a panel with no agent to relaunch", () => {
    expect(buildMissingCliRelaunchOptions(gate({ launchAgentId: undefined }))).toBeNull();
  });

  it("normalises any non-dock location to the grid", () => {
    expect(buildMissingCliRelaunchOptions(gate({ location: "trash" }))?.location).toBe("grid");
    expect(buildMissingCliRelaunchOptions(gate({ location: "dock" }))?.location).toBe("dock");
  });
});

describe("findEquivalentMissingCliGate", () => {
  it("collapses repeated clicks onto the gate already standing in for the launch", () => {
    const existing = gate({ id: "gate-existing" });
    const candidate = gate({ id: "gate-new" });

    const { panelsById, panelIds } = index([existing]);
    expect(findEquivalentMissingCliGate(panelsById, panelIds, candidate)).toBe("gate-existing");
  });

  it.each([
    ["worktree", { worktreeId: "wt-2" }],
    ["location", { location: "dock" as const }],
    ["preset", { agentPresetId: "other" }],
    ["model", { agentModelId: "sonnet" }],
    ["cwd", { cwd: "/elsewhere" }],
    ["command", { command: "claude --resume" }],
    ["launch flags", { agentLaunchFlags: ["--verbose"] }],
    ["agent", { launchAgentId: "gemini" }],
  ])("keeps a gate whose %s differs separate", (_label, difference) => {
    const existing = gate({ id: "gate-existing" });
    const candidate = gate({ id: "gate-new", ...difference });

    const { panelsById, panelIds } = index([existing]);
    expect(findEquivalentMissingCliGate(panelsById, panelIds, candidate)).toBeNull();
  });

  it("ignores panels that are not missing-CLI gates", () => {
    const running = gate({ id: "running", spawnStatus: "ready" });
    const candidate = gate({ id: "gate-new" });

    const { panelsById, panelIds } = index([running]);
    expect(findEquivalentMissingCliGate(panelsById, panelIds, candidate)).toBeNull();
  });

  it("does not resurrect a gate the user already dismissed", () => {
    const trashed = gate({ id: "gate-trashed", location: "trash" });
    const candidate = gate({ id: "gate-new" });

    const { panelsById, panelIds } = index([trashed]);
    expect(findEquivalentMissingCliGate(panelsById, panelIds, candidate)).toBeNull();
  });

  it("never matches the candidate against itself", () => {
    const candidate = gate({ id: "gate-self" });
    const { panelsById, panelIds } = index([candidate]);
    expect(findEquivalentMissingCliGate(panelsById, panelIds, candidate)).toBeNull();
  });

  it("matches regardless of the order fields were written onto the panel", () => {
    const existing = gate({ id: "gate-existing", agentModelId: "opus", agentPresetId: "fast" });
    const candidate = gate({ id: "gate-new", agentPresetId: "fast", agentModelId: "opus" });

    const { panelsById, panelIds } = index([existing]);
    expect(findEquivalentMissingCliGate(panelsById, panelIds, candidate)).toBe("gate-existing");
  });
});
