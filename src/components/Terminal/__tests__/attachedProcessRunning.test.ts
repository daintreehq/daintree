import { describe, expect, it } from "vitest";
import { isAttachedProcessRunning, type AttachedProcessState } from "../attachedProcessRunning";

const live: AttachedProcessState = {
  spawnStatus: "ready",
  runtimeStatus: "running",
  isExited: false,
  isRestarting: false,
  hasSpawnError: false,
  hasRestartError: false,
  backendStatus: "connected",
};

describe("isAttachedProcessRunning", () => {
  it("vouches for a ready pane nothing says has stopped, hydrated ones included", () => {
    expect(isAttachedProcessRunning(live)).toBe(true);
    expect(isAttachedProcessRunning({ ...live, spawnStatus: undefined })).toBe(true);
  });

  it.each<[string, Partial<AttachedProcessState>]>([
    ["exited", { isExited: true }],
    ["runtime exited", { runtimeStatus: "exited" }],
    ["runtime error", { runtimeStatus: "error" }],
    ["restarting", { isRestarting: true }],
    ["failed spawn", { spawnStatus: "failed", hasSpawnError: true }],
    ["still spawning", { spawnStatus: "spawning" }],
    ["restart error", { hasRestartError: true }],
    ["backend disconnected", { backendStatus: "disconnected" }],
    ["backend recovering", { backendStatus: "recovering" }],
  ])("doesn't once the pane is %s (#15233)", (_label, change) => {
    expect(isAttachedProcessRunning({ ...live, ...change })).toBe(false);
  });
});
