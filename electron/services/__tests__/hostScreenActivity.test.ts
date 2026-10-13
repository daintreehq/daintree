import { beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({ contexts: [] as unknown[] }));
const presence = vi.hoisted(() => ({ value: "present" as "present" | "away" | "unknown" }));

vi.mock("../../window/windowRef.js", () => ({
  getWindowRegistry: () => ({ all: () => registry.contexts }),
}));
vi.mock("../userPresence.js", () => ({ readUserPresence: () => presence.value }));

import { isLocalViewInActiveUse } from "../hostScreenActivity.js";

function windowShowing(activeId: number | null, focused: boolean) {
  return {
    browserWindow: { isDestroyed: () => false, isFocused: () => focused },
    services: {
      projectViewManager: {
        getActiveView: () =>
          activeId === null ? null : { webContents: { id: activeId, isDestroyed: () => false } },
      },
    },
  };
}

const view = (handle: number) => ({ kind: "local-view" as const, handle });

beforeEach(() => {
  registry.contexts = [];
  presence.value = "present";
});

describe("isLocalViewInActiveUse", () => {
  it("is in use only as the active view of a focused window", () => {
    registry.contexts = [windowShowing(4, false), windowShowing(7, true)];
    expect(isLocalViewInActiveUse(view(7))).toBe(true);
    expect(isLocalViewInActiveUse(view(4))).toBe(false);
    expect(isLocalViewInActiveUse(view(9))).toBe(false);
  });

  it("is not in use once the person there has stepped away, and is when presence can't be read", () => {
    registry.contexts = [windowShowing(7, true)];
    presence.value = "away";
    expect(isLocalViewInActiveUse(view(7))).toBe(false);
    presence.value = "unknown";
    expect(isLocalViewInActiveUse(view(7))).toBe(true);
  });

  it("never counts a remote view", () => {
    registry.contexts = [windowShowing(-3, true)];
    expect(isLocalViewInActiveUse({ kind: "remote-view", handle: -3 })).toBe(false);
  });
});
