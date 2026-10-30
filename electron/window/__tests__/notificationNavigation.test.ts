import { beforeEach, describe, expect, it, vi } from "vitest";

const ownership = vi.hoisted(() => ({
  findOtherProjectOwner: vi.fn(),
  redirectToProjectOwner: vi.fn(),
  requestProjectSwitchInWindow: vi.fn(),
}));
vi.mock("../projectOwnership.js", () => ownership);

const host = vi.hoisted(() => ({ isWindowOnRemoteHost: vi.fn(() => false) }));
vi.mock("../windowHost.js", () => host);

import { createNotificationProjectOpener } from "../notificationNavigation.js";
import type { Project } from "../../../shared/types/project.js";
import type { WindowRegistry } from "../WindowRegistry.js";

const project = (status: Project["status"] = "background") =>
  ({ id: "proj-1", name: "Alpha", path: "/alpha", status }) as Project;

const projectViewManager = { setPendingFocusIntent: vi.fn() };
const context = {
  windowId: 7,
  browserWindow: { isDestroyed: () => false },
  services: { projectViewManager },
};
const registry = {
  getByWindowId: vi.fn((id: number) => (id === 7 ? context : undefined)),
} as unknown as WindowRegistry;

const place = { windowId: 7, workspaceKey: "proj-1" };
const focus = { intent: "focus-panel", panelId: "term-9" };

beforeEach(() => {
  vi.clearAllMocks();
  ownership.findOtherProjectOwner.mockReturnValue(null);
  host.isWindowOnRemoteHost.mockReturnValue(false);
});

describe("createNotificationProjectOpener", () => {
  it("brings the window holding the project forward and lands on the panel there", () => {
    const owner = { state: "cached" };
    ownership.findOtherProjectOwner.mockReturnValue(owner);
    const open = createNotificationProjectOpener(registry, () => project());

    expect(open(place, "term-9")).toBe(true);

    expect(ownership.findOtherProjectOwner).toHaveBeenCalledWith(registry, "proj-1", {});
    expect(ownership.redirectToProjectOwner).toHaveBeenCalledWith(owner, project(), focus);
    expect(ownership.requestProjectSwitchInWindow).not.toHaveBeenCalled();
  });

  it("opens an evicted project in the window it was in", () => {
    const open = createNotificationProjectOpener(registry, () => project());

    expect(open(place, "term-9")).toBe(true);

    expect(ownership.requestProjectSwitchInWindow).toHaveBeenCalledWith(
      context,
      projectViewManager,
      project(),
      focus
    );
  });

  it("opens nothing for a project closed or missing since, or one it can't find", () => {
    for (const lookup of [() => project("closed"), () => project("missing"), () => null]) {
      expect(createNotificationProjectOpener(registry, lookup)(place, "term-9")).toBe(false);
    }
    expect(ownership.redirectToProjectOwner).not.toHaveBeenCalled();
    expect(ownership.requestProjectSwitchInWindow).not.toHaveBeenCalled();
  });

  it("leaves a window that has gone, or moved to a remote host, to the caller's fallback", () => {
    const open = createNotificationProjectOpener(registry, () => project());
    expect(open({ windowId: 99, workspaceKey: "proj-1" }, "term-9")).toBe(false);

    host.isWindowOnRemoteHost.mockReturnValue(true);
    expect(open(place, "term-9")).toBe(false);
    expect(ownership.requestProjectSwitchInWindow).not.toHaveBeenCalled();
  });
});
