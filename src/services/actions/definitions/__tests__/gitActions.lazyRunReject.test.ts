import { describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify }));

// The run bodies' import itself rejects, which is what a missing or poisoned
// chunk does. Its own file: `gitActions.lazyRun.test.ts` mocks the same module
// with a getter that throws after the import resolved, and the two can't share
// a module registry.
vi.mock("../gitActions.impl", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

import { registerGitActions } from "../gitActions";

describe("git action run bodies that never load (#16667)", () => {
  it("reports the failed load for an action that owns its failure toast", async () => {
    const actions: ActionRegistry = new Map();
    registerGitActions(actions, Object.create(null) as ActionCallbacks);
    const def = actions.get("git.push")!();

    await expect(def.run({ cwd: "/repo/one" }, { dispatchSource: "keybinding" })).rejects.toThrow();

    expect(notify).toHaveBeenCalledTimes(1);
    const toast = notify.mock.calls[0]![0] as { type: string; message: string };
    expect(toast.type).toBe("error");
    // Not the import's own message, which is a bundle path.
    expect(toast.message).not.toContain("dynamically imported");
  });
});
