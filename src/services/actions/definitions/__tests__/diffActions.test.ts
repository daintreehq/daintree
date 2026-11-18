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
// A mounted diff viewer claims what it takes, as `useDiffCommands` does.
let claims = true;
const listener = (event: Event) => {
  received.push((event as CustomEvent<DiffCommandDetail>).detail);
  if (claims) event.preventDefault();
};

async function run(
  id: string,
  args?: unknown,
  ctx: Partial<ActionContext> = {}
): Promise<DiffCommandDetail[]> {
  received.length = 0;
  await definition(id).run(args, ctx as ActionContext);
  return [...received];
}

const viaApi = (id: string, command: DiffCommandDetail["command"]) => ({
  id,
  command,
  fromKeyboard: false,
});

beforeEach(() => {
  for (const key of Object.keys(panels)) delete panels[key];
  focus.id = null;
  claims = true;
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

    expect(await run("diff.nextChange")).toEqual([viaApi("diff-1", "nextChange")]);
    expect(await run("diff.previousChange")).toEqual([viaApi("diff-1", "previousChange")]);
    expect(await run("diff.nextFile")).toEqual([viaApi("diff-1", "nextFile")]);
    expect(await run("diff.previousFile")).toEqual([viaApi("diff-1", "previousFile")]);
    expect(await run("diff.toggleViewed")).toEqual([viaApi("diff-1", "toggleViewed")]);
  });

  it("says when a command came from a key, so the focused control can mean something", async () => {
    panels["diff-1"] = { kind: "diff" };
    focus.id = "diff-1";

    expect(await run("diff.toggleViewed", undefined, { dispatchSource: "keybinding" })).toEqual([
      { id: "diff-1", command: "toggleViewed", fromKeyboard: true },
    ]);
    expect(await run("diff.toggleViewed", undefined, { dispatchSource: "agent" })).toEqual([
      viaApi("diff-1", "toggleViewed"),
    ]);
  });

  it("addresses the topmost presented dialog over the grid's focused panel", async () => {
    // The Review Hub drills into a per-file diff without moving the grid's focus.
    panels["diff-grid"] = { kind: "diff" };
    panels["diff-under"] = { kind: "diff" };
    panels["diff-dialog"] = { kind: "diff" };
    focus.id = "diff-grid";
    usePanelDialogStore.setState({
      dialogStack: ["diff-under", "diff-dialog"],
      dialogFrames: { "diff-under": { kind: "diff" }, "diff-dialog": { kind: "diff" } },
    });

    expect(await run("diff.nextChange")).toEqual([viaApi("diff-dialog", "nextChange")]);
  });

  it("refuses when what's focused or presented isn't a diff viewer", async () => {
    panels["term-1"] = { kind: "terminal" };
    panels["diff-1"] = { kind: "diff" };
    focus.id = "term-1";
    await expect(run("diff.nextFile")).rejects.toThrow("No diff viewer is focused");
    expect(received).toEqual([]);

    // A dialog of another kind covers a focused diff: the diff isn't the one in use.
    focus.id = "diff-1";
    panels["review-1"] = { kind: "review" };
    usePanelDialogStore.setState({
      dialogStack: ["review-1"],
      dialogFrames: { "review-1": { kind: "review" } },
    });
    await expect(run("diff.nextFile")).rejects.toThrow("No diff viewer is focused");
  });

  it("takes an explicit panel over the focused one, only when it is a diff viewer", async () => {
    panels["diff-1"] = { kind: "diff" };
    panels["diff-2"] = { kind: "diff" };
    panels["term-1"] = { kind: "terminal" };
    focus.id = "diff-1";

    expect(await run("diff.toggleViewed", { panelId: "diff-2" })).toEqual([
      viaApi("diff-2", "toggleViewed"),
    ]);
    await expect(run("diff.toggleViewed", { panelId: "term-1" })).rejects.toThrow();
    await expect(run("diff.toggleViewed", { panelId: "gone" })).rejects.toThrow();
  });

  it("refuses rather than report success when no mounted viewer takes the command", async () => {
    // A diff in a background tab of a group: in the store, but not rendered.
    panels["diff-1"] = { kind: "diff" };
    claims = false;

    await expect(run("diff.nextFile", { panelId: "diff-1" })).rejects.toThrow(
      "That diff viewer isn't showing"
    );
  });

  it("dims in the palette until a diff viewer is in use", () => {
    const palette = definition("diff.nextChange").palette;
    expect(palette?.mode).toBe("requireContext");
    const isReady = palette && "isReady" in palette ? palette.isReady : undefined;
    expect(isReady?.({} as ActionContext)).toBe(false);

    panels["term-1"] = { kind: "terminal" };
    focus.id = "term-1";
    expect(isReady?.({} as ActionContext)).toBe(false);

    panels["diff-1"] = { kind: "diff" };
    focus.id = "diff-1";
    expect(isReady?.({} as ActionContext)).toBe(true);
  });
});
