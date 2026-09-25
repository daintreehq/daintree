import { describe, expect, it } from "vitest";
import type { PanelSnapshot, ProjectState } from "../../../../shared/types/project.js";
import { recordViewlessTerminal, type ProjectStateWriter } from "../projectStateAuthoring.js";

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
