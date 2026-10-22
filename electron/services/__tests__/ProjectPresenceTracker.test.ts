import { describe, expect, it, vi } from "vitest";
import { ProjectPresenceTracker } from "../ProjectPresenceTracker.js";
import type { PluginProjectPresence } from "../../../shared/types/plugin.js";

const ALPHA = "a".repeat(64);
const BETA = "b".repeat(64);
const SCRATCH = "11111111-2222-4333-8444-555555555555";
const REMOTE_VIEW = `host-1:${ALPHA}`;

function setup() {
  let shown: string[] = [];
  const tracker = new ProjectPresenceTracker(() => shown);
  const changes: PluginProjectPresence[][] = [];
  tracker.subscribe((batch) => changes.push([...batch]));
  const show = (...ids: string[]) => {
    shown = ids;
    tracker.refresh();
  };
  return { tracker, changes, show };
}

describe("ProjectPresenceTracker", () => {
  it("reads a project the seam opened as background until a window shows it", () => {
    const { tracker, changes, show } = setup();
    tracker.markOpened(ALPHA);
    expect(tracker.getState(ALPHA)).toBe("background");

    show(ALPHA);
    expect(tracker.getState(ALPHA)).toBe("foreground");
    expect(changes).toEqual([
      [{ projectId: ALPHA, state: "background" }],
      [{ projectId: ALPHA, state: "foreground" }],
    ]);
  });

  it("reports both sides of a switch in one batch", () => {
    const { tracker, changes, show } = setup();
    tracker.markOpened(ALPHA);
    tracker.markOpened(BETA);
    show(ALPHA);
    changes.length = 0;

    show(BETA);
    expect(changes).toEqual([
      [
        { projectId: BETA, state: "foreground" },
        { projectId: ALPHA, state: "background" },
      ],
    ]);
  });

  it("keeps a project shown in two windows foreground in both", () => {
    const { tracker, show } = setup();
    show(ALPHA, BETA);
    expect(tracker.getState(ALPHA)).toBe("foreground");
    expect(tracker.getState(BETA)).toBe("foreground");
  });

  it("leaves a project open when its window goes away or its view is reclaimed", () => {
    const { tracker, changes, show } = setup();
    show(ALPHA);
    changes.length = 0;

    show();
    expect(tracker.getState(ALPHA)).toBe("background");
    expect(changes).toEqual([[{ projectId: ALPHA, state: "background" }]]);
    expect(tracker.getOpen()).toEqual([{ projectId: ALPHA, state: "background" }]);
  });

  it("closes a project once, and forgets it", () => {
    const { tracker, changes } = setup();
    tracker.markOpened(ALPHA);
    changes.length = 0;

    tracker.markClosed(ALPHA);
    tracker.markClosed(ALPHA);
    expect(changes).toEqual([[{ projectId: ALPHA, state: "closed" }]]);
    expect(tracker.getState(ALPHA)).toBe("closed");
    expect(tracker.getOpen()).toEqual([]);
  });

  it("lets a close outrank a window still pointing at the project, until the pointer moves", () => {
    const { tracker, changes, show } = setup();
    show(ALPHA);
    changes.length = 0;

    tracker.markClosed(ALPHA);
    expect(tracker.getState(ALPHA)).toBe("closed");
    show(ALPHA);
    expect(tracker.getState(ALPHA)).toBe("closed");

    show(BETA);
    show(ALPHA);
    expect(tracker.getState(ALPHA)).toBe("foreground");
    expect(changes.flat().filter((change) => change.projectId === ALPHA)).toEqual([
      { projectId: ALPHA, state: "closed" },
      { projectId: ALPHA, state: "foreground" },
    ]);
  });

  it("clears a close when the seam reopens the project", () => {
    const { tracker, show } = setup();
    show(ALPHA);
    tracker.markClosed(ALPHA);
    tracker.markOpened(ALPHA);
    expect(tracker.getState(ALPHA)).toBe("foreground");
  });

  it("tracks scratches but never another host's view keys", () => {
    const { tracker, show } = setup();
    show(SCRATCH, REMOTE_VIEW);
    tracker.markOpened(REMOTE_VIEW);

    expect(tracker.getOpen()).toEqual([{ projectId: SCRATCH, state: "foreground" }]);
  });

  it("emits nothing when nothing moved", () => {
    const { tracker, changes, show } = setup();
    show(ALPHA);
    changes.length = 0;
    show(ALPHA);
    tracker.refresh();
    expect(changes).toEqual([]);
  });

  it("keeps its last answer when the reader throws", () => {
    let fail = false;
    const tracker = new ProjectPresenceTracker(() => {
      if (fail) throw new Error("registry tearing down");
      return [ALPHA];
    });
    tracker.refresh();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fail = true;
    tracker.refresh();
    error.mockRestore();

    expect(tracker.getState(ALPHA)).toBe("foreground");
  });

  it("isolates a throwing listener and stops calling an unsubscribed one", () => {
    const tracker = new ProjectPresenceTracker(() => []);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    tracker.subscribe(() => {
      throw new Error("boom");
    });
    const later = vi.fn();
    const off = tracker.subscribe(later);
    tracker.markOpened(ALPHA);
    off();
    tracker.markOpened(BETA);
    error.mockRestore();

    expect(later).toHaveBeenCalledTimes(1);
  });

  it("re-reads when the window reader is installed", () => {
    const tracker = new ProjectPresenceTracker();
    tracker.markOpened(ALPHA);
    tracker.setShownReader(() => [ALPHA]);
    expect(tracker.getState(ALPHA)).toBe("foreground");
  });
});
