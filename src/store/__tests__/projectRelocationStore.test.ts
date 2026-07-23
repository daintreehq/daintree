import { beforeEach, describe, expect, it } from "vitest";
import {
  useProjectRelocationStore,
  type PendingProjectRelocation,
} from "@/store/projectRelocationStore";

const TARGET: PendingProjectRelocation = {
  projectId: "p1",
  mode: "move",
  oldPath: "/repos/proj",
  name: "Proj",
};

describe("projectRelocationStore", () => {
  beforeEach(() => {
    useProjectRelocationStore.setState({ pending: null, requestSeq: 0 });
  });

  it("open() stores the exact target and bumps requestSeq", () => {
    useProjectRelocationStore.getState().open(TARGET);
    const state = useProjectRelocationStore.getState();
    expect(state.pending).toEqual(TARGET);
    expect(state.requestSeq).toBe(1);
  });

  it("a second open() supersedes the first and bumps requestSeq again", () => {
    const { open } = useProjectRelocationStore.getState();
    open(TARGET);
    const next: PendingProjectRelocation = {
      projectId: "p2",
      mode: "reattach",
      oldPath: "/repos/gone",
      name: "Gone",
    };
    open(next);
    const state = useProjectRelocationStore.getState();
    expect(state.pending).toEqual(next);
    expect(state.requestSeq).toBe(2);
  });

  it("close() clears pending without rewinding requestSeq", () => {
    const { open, close } = useProjectRelocationStore.getState();
    open(TARGET);
    close();
    const state = useProjectRelocationStore.getState();
    expect(state.pending).toBeNull();
    // The monotonic sequence is a re-init signal, not a counter of open dialogs —
    // closing must not rewind it.
    expect(state.requestSeq).toBe(1);
  });
});
