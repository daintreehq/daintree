import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

const views = vi.hoisted(() => [] as Array<{ webContents: WebContents; projectId: string }>);
const scopeListeners = vi.hoisted(() => new Set<() => void>());
vi.mock("../webContentsRegistry.js", () => ({
  getRegisteredProjectViews: () => [...views],
  onRendererScopeChanged: (listener: () => void) => {
    scopeListeners.add(listener);
    return () => scopeListeners.delete(listener);
  },
}));

import { freezeWebContents, unfreezeWebContents } from "../../utils/webContentsLifecycle.js";
import {
  getFrozenViewProjectIds,
  startFrozenViewProjectsPublisher,
} from "../frozenViewProjects.js";

let nextId = 1;

function addView(projectId: string): WebContents {
  const wc = {
    id: nextId++,
    isDestroyed: () => false,
    debugger: { isAttached: () => true, attach: vi.fn(), sendCommand: vi.fn(async () => {}) },
  } as unknown as WebContents;
  views.push({ webContents: wc, projectId });
  return wc;
}

function scopeChanged(): void {
  for (const listener of [...scopeListeners]) listener();
}

describe("frozenViewProjects (#17038)", () => {
  beforeEach(() => {
    views.length = 0;
    scopeListeners.clear();
  });

  it("names a project only when every one of its views is frozen", async () => {
    const a1 = addView("proj-a");
    const a2 = addView("proj-a");
    const b = addView("proj-b");
    addView("proj-c");

    await freezeWebContents(a1);
    await freezeWebContents(b);
    expect(getFrozenViewProjectIds()).toEqual(["proj-b"]);

    await freezeWebContents(a2);
    expect(getFrozenViewProjectIds()).toEqual(["proj-a", "proj-b"]);
  });

  it("publishes on every change to the set, and only then", async () => {
    const publish = vi.fn();
    const a = addView("proj-a");
    const stop = startFrozenViewProjectsPublisher(publish);
    // The host starts empty, so an empty set is never sent.
    expect(publish).not.toHaveBeenCalled();

    await freezeWebContents(a);
    expect(publish.mock.calls).toEqual([[["proj-a"]]]);

    // A second view of the project that can still read output takes it back out.
    addView("proj-a");
    scopeChanged();
    expect(publish.mock.calls.at(-1)).toEqual([[]]);

    views.pop();
    scopeChanged();
    expect(publish.mock.calls.at(-1)).toEqual([["proj-a"]]);

    // A renderer that is no project view (a webview guest) leaves the set as it was.
    const callsBefore = publish.mock.calls.length;
    const guest = addView("proj-z");
    views.pop();
    await freezeWebContents(guest);
    expect(publish).toHaveBeenCalledTimes(callsBefore);

    await unfreezeWebContents(a);
    expect(publish.mock.calls.at(-1)).toEqual([[]]);

    stop();
    await freezeWebContents(a);
    expect(publish.mock.calls.at(-1)).toEqual([[]]);
    expect(scopeListeners.size).toBe(0);
  });
});
