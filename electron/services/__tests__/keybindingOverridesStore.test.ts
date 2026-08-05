import { beforeEach, describe, expect, it, vi } from "vitest";

const storeGetMock = vi.hoisted(() => vi.fn<(key: string) => unknown>());

vi.mock("../../store.js", () => ({ store: { get: storeGetMock } }));

const { getValidatedOverrides } = await import("../keybindingOverridesStore.js");

function seedOverrides(overrides: unknown) {
  storeGetMock.mockReturnValue(overrides);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getValidatedOverrides", () => {
  it("keeps well-formed overrides and drops malformed ones", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    seedOverrides({
      "terminal.new": ["Cmd+T"],
      "terminal.close": "Cmd+W",
      // An empty array is a deliberate unbind, not a malformed entry — dropping
      // it would hand the shortcut back to a user who removed it on purpose.
      "terminal.kill": [],
      "terminal.rename": [" "],
    });

    // A hand-edited or corrupt entry must not take a binding down with it.
    expect(getValidatedOverrides()).toEqual({ "terminal.new": ["Cmd+T"], "terminal.kill": [] });
  });

  it.each([null, undefined, "nope", []])("answers empty for a %s root", (raw) => {
    seedOverrides(raw);
    expect(getValidatedOverrides()).toEqual({});
  });

  describe("actions whose default binding moved (#11666)", () => {
    it("carries a custom combo onto the successor action", () => {
      // Overrides are keyed by action id and only resolve for an id that
      // carries a binding row, so moving the default without this would leave
      // the user's own shortcut recorded but inert.
      seedOverrides({ "worktree.openFileBrowser": ["Cmd+Shift+B"] });

      expect(getValidatedOverrides()["worktree.openFileBrowserPanel"]).toEqual(["Cmd+Shift+B"]);
    });

    it("carries a deliberate unbind onto the successor", () => {
      // Without this the successor's default combo comes back for a user who
      // removed it on purpose — a shortcut re-appearing is the louder failure.
      seedOverrides({ "worktree.openFileBrowser": [] });

      expect(getValidatedOverrides()["worktree.openFileBrowserPanel"]).toEqual([]);
    });

    it("leaves an explicit choice on the successor alone", () => {
      // Someone who has already rebound the new action is never dragged back to
      // what they picked for the old one.
      seedOverrides({
        "worktree.openFileBrowser": ["Cmd+Shift+B"],
        "worktree.openFileBrowserPanel": ["Cmd+Alt+B"],
      });

      expect(getValidatedOverrides()["worktree.openFileBrowserPanel"]).toEqual(["Cmd+Alt+B"]);
    });

    it("does not invent a binding when the old action was never customized", () => {
      seedOverrides({ "terminal.new": ["Cmd+T"] });

      expect(getValidatedOverrides()).not.toHaveProperty("worktree.openFileBrowserPanel");
    });

    it("does not carry a malformed legacy entry onto the successor", () => {
      // Validation runs first, so a corrupt old value is dropped rather than
      // promoted onto an id that previously had nothing wrong with it.
      vi.spyOn(console, "warn").mockImplementation(() => {});
      seedOverrides({ "worktree.openFileBrowser": "Cmd+Shift+B" });

      expect(getValidatedOverrides()).not.toHaveProperty("worktree.openFileBrowserPanel");
    });
  });
});
