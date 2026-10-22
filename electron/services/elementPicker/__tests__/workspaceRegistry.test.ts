import { describe, expect, it, vi } from "vitest";
import {
  MAX_OPEN_WORKSPACES,
  WorkspaceRegistry,
  type PickerWorkspace,
} from "../workspaceRegistry.js";
import type { SourceTracker } from "../sourceTracker.js";

function workspace(id: string): PickerWorkspace & { dispose: ReturnType<typeof vi.fn> } {
  const dispose = vi.fn();
  return {
    id,
    roots: { worktreePath: "/repo", appRoot: "/repo" },
    previewOrigin: null,
    lifetime: new AbortController(),
    tracker: { dispose } as unknown as SourceTracker,
    dispose,
  };
}

describe("WorkspaceRegistry", () => {
  it("releases the least recently used workspace past the cap", () => {
    const registry = new WorkspaceRegistry();
    const all = Array.from({ length: MAX_OPEN_WORKSPACES }, (_, index) => workspace(`w${index}`));
    for (const entry of all) registry.add(entry);
    // Touching the oldest makes the second oldest the one to go.
    registry.get("w0");
    registry.add(workspace("extra"));
    expect(registry.get("w0")).toBe(all[0]);
    expect(registry.get("w1")).toBeUndefined();
    expect(all[1]!.lifetime.signal.aborted).toBe(true);
    expect(all[1]!.dispose).toHaveBeenCalled();
  });

  it("aborts the lifetime and disposes the tracker on close", () => {
    const registry = new WorkspaceRegistry();
    const entry = workspace("w");
    registry.add(entry);
    expect(registry.close("w")).toBe(true);
    expect(registry.close("w")).toBe(false);
    expect(entry.lifetime.signal.aborted).toBe(true);
    expect(entry.dispose).toHaveBeenCalledTimes(1);
  });
});
