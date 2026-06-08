import { beforeEach, describe, expect, it, vi } from "vitest";

const notifyMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

import { notifyRecipeSpawnFailures } from "../recipeNotify";

function failure(index: number, error: string) {
  return { index, error };
}

function spawned(index: number) {
  return { index, terminalId: `term-${index}` };
}

beforeEach(() => {
  notifyMock.mockReset();
});

describe("notifyRecipeSpawnFailures", () => {
  it("does nothing when all terminals spawned", () => {
    notifyRecipeSpawnFailures(
      { spawned: [spawned(0), spawned(1)], failed: [] },
      { recipeName: "Dev setup" }
    );
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("does nothing for an empty result set", () => {
    notifyRecipeSpawnFailures({ spawned: [], failed: [] });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("emits an error when no terminals spawned", () => {
    notifyRecipeSpawnFailures(
      {
        spawned: [],
        failed: [failure(0, "Panel limit reached"), failure(1, "Panel limit reached")],
      },
      { recipeName: "Dev setup", projectId: "p1" }
    );

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyMock.mock.calls[0]![0];
    expect(payload.type).toBe("error");
    expect(payload.title).toBe("Recipe launch failed");
    expect(payload.message).toContain("'Dev setup'");
    expect(payload.message).toContain("Panel limit reached");
    expect(payload.context).toEqual({ eventKind: "agent", projectId: "p1" });
    // The banned error + priority:"low" combination silently drops the toast.
    expect(payload.priority).toBeUndefined();
    // worktreeId would trigger notify()'s origin-surface suppression and
    // swallow the toast when the failing worktree is active — must never be set.
    expect(payload.context.worktreeId).toBeUndefined();
  });

  it("emits a warning when only some terminals failed", () => {
    notifyRecipeSpawnFailures(
      { spawned: [spawned(0), spawned(1)], failed: [failure(2, "Panel limit reached")] },
      { recipeName: "Dev setup" }
    );

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyMock.mock.calls[0]![0];
    expect(payload.type).toBe("warning");
    expect(payload.title).toBe("Recipe partially launched");
    expect(payload.message).toContain("1 of 3 terminals");
    expect(payload.context.eventKind).toBe("agent");
  });

  it("counts mixed-reason partial failures without relaying a reason", () => {
    notifyRecipeSpawnFailures(
      {
        spawned: [spawned(0), spawned(1)],
        failed: [failure(2, "Panel limit reached"), failure(3, "spawn ENOENT")],
      },
      { recipeName: "Dev setup" }
    );

    const payload = notifyMock.mock.calls[0]![0];
    expect(payload.type).toBe("warning");
    expect(payload.message).toContain("2 of 4 terminals");
    expect(payload.message).not.toContain("Panel limit reached");
    expect(payload.message).not.toContain("ENOENT");
  });

  it("relays a single shared failure reason but omits mixed reasons", () => {
    notifyRecipeSpawnFailures(
      { spawned: [], failed: [failure(0, "Panel limit reached"), failure(1, "spawn ENOENT")] },
      { recipeName: "Dev setup" }
    );

    const mixed = notifyMock.mock.calls[0]![0];
    expect(mixed.message).not.toContain("Panel limit reached");
    expect(mixed.message).not.toContain("ENOENT");

    notifyMock.mockReset();
    notifyRecipeSpawnFailures(
      { spawned: [], failed: [failure(0, "spawn ENOENT"), failure(1, "spawn ENOENT")] },
      { recipeName: "Dev setup" }
    );
    expect(notifyMock.mock.calls[0]![0].message).toContain("spawn ENOENT");
  });

  it("falls back to a generic name when the recipe name is unknown", () => {
    notifyRecipeSpawnFailures({ spawned: [], failed: [failure(0, "boom")] });
    expect(notifyMock.mock.calls[0]![0].message).toContain("the recipe");
  });
});
