import { afterEach, describe, expect, it } from "vitest";
import type { PanelSnapshot, ProjectState } from "../../../../shared/types/project.js";
import { recordViewlessTerminal, type ProjectStateWriter } from "../projectStateAuthoring.js";
import {
  _resetHostStartedTerminalsForTesting,
  hostStartedTerminals,
} from "../hostStartedTerminals.js";
import { backgroundViewlessTerminal, forgetViewlessTerminal } from "../projectStateAuthoring.js";

const startedIds = (projectId: string) => hostStartedTerminals(projectId).map((t) => t.id);

function writerOver(initial: ProjectState | null) {
  let state = initial;
  let writes = 0;
  const writer: ProjectStateWriter = {
    enqueueProjectStateUpdate: async (_projectId, updater) => {
      const next = await updater(state);
      if (next !== null) {
        state = next;
        writes++;
      }
    },
  };
  return { writer, read: () => state, writes: () => writes };
}

const SNAPSHOT: PanelSnapshot = {
  id: "t-1",
  kind: "terminal",
  title: "Terminal",
  location: "grid",
};

describe("recordViewlessTerminal", () => {
  afterEach(() => _resetHostStartedTerminalsForTesting());

  it("notes the terminal as host-started, with its placement, before the state write (#14473)", async () => {
    let notedBeforeWrite: string[] = [];
    const writer: ProjectStateWriter = {
      enqueueProjectStateUpdate: async () => {
        notedBeforeWrite = startedIds("proj-1");
        throw new Error("disk full");
      },
    };

    await expect(
      recordViewlessTerminal(writer, "proj-1", {
        ...SNAPSHOT,
        location: "background",
        worktreeId: "/repo",
      })
    ).rejects.toThrow("disk full");

    expect(notedBeforeWrite).toEqual(["t-1"]);
    expect(hostStartedTerminals("proj-1")).toEqual([
      { id: "t-1", location: "background", worktreeId: "/repo", heldBy: new Set() },
    ]);
    expect(startedIds("proj-2")).toEqual([]);
  });

  it("forgets a host-started terminal a viewless close takes out", async () => {
    const { writer } = writerOver(null);
    await recordViewlessTerminal(writer, "proj-1", SNAPSHOT);
    await recordViewlessTerminal(writer, "proj-1", { ...SNAPSHOT, id: "t-2" });

    await forgetViewlessTerminal(writer, "proj-1", "t-1");

    expect(startedIds("proj-1")).toEqual(["t-2"]);
  });

  it("creates a project's first state around the terminal", async () => {
    const { writer, read } = writerOver(null);

    await recordViewlessTerminal(writer, "proj-1", SNAPSHOT);

    expect(read()).toEqual({ projectId: "proj-1", sidebarWidth: 350, terminals: [SNAPSHOT] });
  });

  it("appends after what a renderer saved, keeping everything else", async () => {
    const saved: ProjectState = {
      projectId: "proj-1",
      sidebarWidth: 280,
      activeWorktreeId: "/repo",
      terminals: [{ id: "t-0", kind: "terminal", title: "Terminal", location: "dock" }],
      draftInputs: { "t-0": "half typed" },
    };
    const { writer, read } = writerOver(saved);

    await recordViewlessTerminal(writer, "proj-1", SNAPSHOT);

    expect(read()).toEqual({ ...saved, terminals: [...saved.terminals, SNAPSHOT] });
  });

  it("leaves a panel the state already has alone", async () => {
    const saved: ProjectState = {
      projectId: "proj-1",
      sidebarWidth: 280,
      terminals: [{ ...SNAPSHOT, title: "Renamed by the user" }],
    };
    const { writer, read, writes } = writerOver(saved);

    await recordViewlessTerminal(writer, "proj-1", SNAPSHOT);

    expect(read()).toBe(saved);
    expect(writes()).toBe(0);
  });
});

describe("backgroundViewlessTerminal (#15982)", () => {
  afterEach(() => _resetHostStartedTerminalsForTesting());

  it("parks a grid or dock panel in the background, coming back where it was", async () => {
    const saved: ProjectState = {
      projectId: "proj-1",
      sidebarWidth: 280,
      terminals: [
        { id: "t-0", kind: "terminal", title: "Shell", location: "grid" },
        { ...SNAPSHOT, location: "dock" },
      ],
      tabGroups: [
        { id: "g-1", location: "dock", activeTabId: "t-1", panelIds: ["t-1", "t-2"] },
        { id: "g-2", location: "grid", activeTabId: "t-1", panelIds: ["t-1"] },
      ],
      terminalLayout: { focusedTerminalId: "t-1", maximizedTerminalId: "t-0" },
      draftInputs: { "t-1": "half typed" },
    };
    const { writer, read } = writerOver(saved);
    await recordViewlessTerminal(writer, "proj-1", SNAPSHOT);

    await backgroundViewlessTerminal(writer, "proj-1", "t-1");

    expect(read()).toEqual({
      ...saved,
      terminals: [
        saved.terminals[0],
        { ...SNAPSHOT, location: "background", backgroundRestoreLocation: "dock" },
      ],
      tabGroups: [{ id: "g-1", location: "dock", activeTabId: "t-2", panelIds: ["t-2"] }],
      terminalLayout: { maximizedTerminalId: "t-0" },
    });
    expect(hostStartedTerminals("proj-1")).toEqual([
      { id: "t-1", location: "background", heldBy: new Set() },
    ]);
  });

  it("leaves a panel already parked, trashed or never saved alone", async () => {
    for (const location of ["background", "trash"] as const) {
      const saved: ProjectState = {
        projectId: "proj-1",
        sidebarWidth: 280,
        terminals: [{ ...SNAPSHOT, location }],
      };
      const { writer, read, writes } = writerOver(saved);
      await backgroundViewlessTerminal(writer, "proj-1", "t-1");
      expect(read()).toBe(saved);
      expect(writes()).toBe(0);
    }
    const { writer, writes } = writerOver(null);
    await backgroundViewlessTerminal(writer, "proj-1", "t-1");
    expect(writes()).toBe(0);
  });
});
