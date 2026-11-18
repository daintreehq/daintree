// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const { panels, focus } = vi.hoisted(() => ({
  panels: {} as Record<string, { kind: string }>,
  focus: { id: null as string | null },
}));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({ focusedId: focus.id, getTerminal: (id: string) => panels[id] }),
  },
}));

import { registerDiffActions } from "../diffActions";
import { DIFF_COMMAND_EVENT, type DiffCommandDetail } from "@/panels/diff/diffCommands";
import { usePanelDialogStore } from "@/store/panelDialogStore";

function definition(id: string): AnyActionDefinition {
  const actions: ActionRegistry = new Map();
  registerDiffActions(actions, {} as ActionCallbacks);
  const factory = actions.get(id as never);
  if (!factory) throw new Error(`missing ${id}`);
  return factory() as AnyActionDefinition;
}

const received: DiffCommandDetail[] = [];
const listener = (event: Event) => received.push((event as CustomEvent<DiffCommandDetail>).detail);

async function run(id: string, args?: unknown): Promise<DiffCommandDetail[]> {
  received.length = 0;
  await definition(id).run(args, {} as ActionContext);
  return [...received];
}

beforeEach(() => {
  for (const key of Object.keys(panels)) delete panels[key];
  focus.id = null;
  usePanelDialogStore.setState({ dialogStack: [], dialogFrames: {} });
  window.addEventListener(DIFF_COMMAND_EVENT, listener);
});

afterEach(() => {
  window.removeEventListener(DIFF_COMMAND_EVENT, listener);
});

describe("diff actions", () => {
  it("sends each action's command to the focused diff viewer", async () => {
    panels["diff-1"] = { kind: "diff" };
    focus.id = "diff-1";

    expect(await run("diff.nextChange")).toEqual([{ id: "diff-1", command: "nextChange" }]);
    expect(await run("diff.previousChange")).toEqual([
      { id: "diff-1", command: "previousChange" },
    ]);
    expect(await run("diff.nextFile")).toEqual([{ id: "diff-1", command: "nextFile" }]);
    expect(await run("diff.previousFile")).toEqual([{ id: "diff-1", command: "previousFile" }]);
    expect(await run("diff.toggleViewed")).toEqual([{ id: "diff-1", command: "toggleViewed" }]);
  });

  it("addresses the presented dialog over the grid's focused panel", async () => {
    // The Review Hub drills into a per-file diff without moving the grid's focus.
    panels["diff-grid"] = { kind: "diff" };
    panels["diff-dialog"] = { kind: "diff" };
    focus.id = "diff-grid";
    usePanelDialogStore.setState({
      dialogStack: ["diff-dialog"],
      dialogFrames: { "diff-dialog": { kind: "diff" } },
    });

    expect(await run("diff.nextChange")).toEqual([{ id: "diff-dialog", command: "nextChange" }]);
  });

  it("sends nothing when what's focused or presented isn't a diff viewer", async () => {
    panels["term-1"] = { kind: "terminal" };
    panels["diff-1"] = { kind: "diff" };
    focus.id = "term-1";
    expect(await run("diff.nextFile")).toEqual([]);

    // A dialog of another kind covers a focused diff: the diff isn't the one in use.
    focus.id = "diff-1";
    panels["review-1"] = { kind: "review" };
    usePanelDialogStore.setState({
      dialogStack: ["review-1"],
      dialogFrames: { "review-1": { kind: "review" } },
    });
    expect(await run("diff.nextFile")).toEqual([]);
  });

  it("takes an explicit panel only when it is a diff viewer", async () => {
    panels["diff-2"] = { kind: "diff" };
    panels["term-1"] = { kind: "terminal" };

    expect(await run("diff.toggleViewed", { panelId: "diff-2" })).toEqual([
      { id: "diff-2", command: "toggleViewed" },
    ]);
    expect(await run("diff.toggleViewed", { panelId: "term-1" })).toEqual([]);
  });

  it("dims in the palette until a diff viewer is in use", () => {
    const palette = definition("diff.nextChange").palette;
    expect(palette?.mode).toBe("requireContext");
    const isReady = palette && "isReady" in palette ? palette.isReady : undefined;
    expect(isReady?.()).toBe(false);

    panels["diff-1"] = { kind: "diff" };
    focus.id = "diff-1";
    expect(isReady?.()).toBe(true);
  });
});
