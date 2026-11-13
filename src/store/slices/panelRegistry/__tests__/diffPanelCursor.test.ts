import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffChangeSetEntry } from "@shared/types/git";

vi.mock("../persistence", () => ({ saveNormalized: vi.fn() }));

import { createDiffPanelActions } from "../diff";

type State = { panelsById: Record<string, Record<string, unknown>>; panelIds: string[] };

const KEY = "working-tree:a.ts";
const twins: DiffChangeSetEntry[] = [
  { path: "a.ts", status: "modified", viewedKey: KEY, side: "staged" },
  { path: "a.ts", status: "modified", viewedKey: KEY, side: "unstaged" },
];

describe("diff panel cursor (#16897)", () => {
  let state: State;
  let actions: ReturnType<typeof createDiffPanelActions>;
  const panel = () => state.panelsById.p!;

  beforeEach(() => {
    state = {
      panelsById: {
        p: {
          id: "p",
          kind: "diff",
          filePath: "a.ts",
          fileStatus: "modified",
          viewedKey: KEY,
          fileSide: "staged",
          changeSet: twins,
        },
      },
      panelIds: ["p"],
    };
    const set = (update: (current: State) => Partial<State> | State) => {
      const next = update(state);
      if (next !== state) state = { ...state, ...next };
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the slice only reads and writes panelsById/panelIds
    actions = createDiffPanelActions(set as never);
  });

  it("moves to the other twin when only the side differs", () => {
    actions.setDiffPanelFile("p", "a.ts", "modified", KEY, "unstaged");
    expect(panel().fileSide).toBe("unstaged");
  });

  it("bails when nothing about the cursor changed", () => {
    const before = state;
    actions.setDiffPanelFile("p", "a.ts", "modified", KEY, "staged");
    expect(state).toBe(before);
  });

  it("drops the side when the caller names none", () => {
    actions.setDiffPanelFile("p", "a.ts", "modified", "base:a.ts");
    expect(panel().viewedKey).toBe("base:a.ts");
    expect("fileSide" in panel()).toBe(false);
  });

  it("takes a change set whose only difference is an entry's side", () => {
    const swapped = twins.map((entry) => ({
      ...entry,
      side: entry.side === "staged" ? ("unstaged" as const) : ("staged" as const),
    }));
    actions.setDiffPanelChangeSet("p", swapped);
    expect(panel().changeSet).toBe(swapped);
  });
});
