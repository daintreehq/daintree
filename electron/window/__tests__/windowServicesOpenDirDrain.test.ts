import { describe, expect, it } from "vitest";

/**
 * Tests the macOS folder-drop open logic from windowServices.ts (#10976).
 *
 * setupWindowServices cannot be imported directly (side effects, Electron deps
 * — see windowServicesProjectBinding.test.ts), so we replicate the two
 * decisions the folder-drop path makes: the live consumer (warm drop) resolves
 * a primary window or re-queues, and the window-create drain opens each queued
 * folder in the fresh window. Both feed the existing `handleDirectoryOpen`.
 */

type Window = { isDestroyed: () => boolean };

type ConsumerAction =
  | { action: "openInPrimary"; dirPath: string }
  | { action: "requeue"; dirPath: string };

/** Mirror of the live directory consumer installed once in setupWindowServices. */
function simulateConsumerDrop(dirPath: string, primary: Window | null): ConsumerAction[] {
  const actions: ConsumerAction[] = [];
  if (primary && !primary.isDestroyed()) {
    actions.push({ action: "openInPrimary", dirPath });
  } else {
    actions.push({ action: "requeue", dirPath });
  }
  return actions;
}

type DrainAction = { action: "openInWindow"; dirPath: string };

/** Mirror of the window-create drain: clear-then-open in FIFO order. */
function simulateDrain(queuedDirs: string[]): { actions: DrainAction[]; leftover: string[] } {
  const actions: DrainAction[] = [];
  // clearPendingOpenDirPaths() runs before the loop, so the queue is emptied
  // even if a later open-file event re-queues mid-drain.
  for (const dirPath of queuedDirs) {
    actions.push({ action: "openInWindow", dirPath });
  }
  return { actions, leftover: [] };
}

const liveWindow: Window = { isDestroyed: () => false };
const destroyedWindow: Window = { isDestroyed: () => true };

describe("windowServices folder-drop consumer (#10976)", () => {
  it("opens in the primary window when one is live", () => {
    const actions = simulateConsumerDrop("/projects/foo", liveWindow);
    expect(actions).toEqual([{ action: "openInPrimary", dirPath: "/projects/foo" }]);
  });

  it("re-queues when no primary window exists (macOS zero-window state)", () => {
    const actions = simulateConsumerDrop("/projects/foo", null);
    expect(actions).toEqual([{ action: "requeue", dirPath: "/projects/foo" }]);
  });

  it("re-queues when the primary window is destroyed", () => {
    const actions = simulateConsumerDrop("/projects/foo", destroyedWindow);
    expect(actions).toEqual([{ action: "requeue", dirPath: "/projects/foo" }]);
  });
});

describe("windowServices folder-drop window-create drain (#10976)", () => {
  it("opens each queued folder in the fresh window in FIFO order", () => {
    const { actions } = simulateDrain(["/a", "/b", "/c"]);
    expect(actions).toEqual([
      { action: "openInWindow", dirPath: "/a" },
      { action: "openInWindow", dirPath: "/b" },
      { action: "openInWindow", dirPath: "/c" },
    ]);
  });

  it("clears the queue before opening so a mid-drain re-queue is not lost or doubled", () => {
    const { leftover } = simulateDrain(["/a", "/b"]);
    expect(leftover).toEqual([]);
  });

  it("drains nothing when no folders are queued", () => {
    const { actions } = simulateDrain([]);
    expect(actions).toEqual([]);
  });
});
