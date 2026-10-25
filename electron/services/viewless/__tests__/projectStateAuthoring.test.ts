import { afterEach, describe, expect, it } from "vitest";
import type { PanelSnapshot, ProjectState } from "../../../../shared/types/project.js";
import { recordViewlessTerminal, type ProjectStateWriter } from "../projectStateAuthoring.js";
import {
  _resetHostStartedTerminalsForTesting,
  hostStartedTerminalIds,
} from "../hostStartedTerminals.js";

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

  it("notes the terminal as host-started even when the state write fails (#14473)", async () => {
    const writer: ProjectStateWriter = {
      enqueueProjectStateUpdate: async () => {
        throw new Error("disk full");
      },
    };

    await expect(recordViewlessTerminal(writer, "proj-1", SNAPSHOT)).rejects.toThrow("disk full");

    expect(hostStartedTerminalIds("proj-1")).toEqual(["t-1"]);
    expect(hostStartedTerminalIds("proj-2")).toEqual([]);
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
