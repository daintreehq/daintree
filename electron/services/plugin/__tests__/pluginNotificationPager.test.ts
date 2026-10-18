import { beforeEach, describe, expect, it, vi } from "vitest";

const notificationServiceMock = vi.hoisted(() => ({
  showNativeNotification: vi.fn(),
  closeNotificationByKey: vi.fn(),
  isWindowFocused: vi.fn(() => false),
  isOwnerViewFocused: vi.fn((_id: number) => false),
}));
const muteMock = vi.hoisted(() => ({ isSessionMuted: vi.fn(() => false) }));
const settingsMock = vi.hoisted(() => ({
  settings: { enabled: true, quietHoursEnabled: false } as Record<string, unknown>,
}));
const quietMock = vi.hoisted(() => ({ isScheduledQuietNow: vi.fn(() => false) }));
const ownershipMock = vi.hoisted(() => ({
  findOtherProjectOwner: vi.fn((): unknown => null),
  redirectToProjectOwner: vi.fn(),
  revealWindow: vi.fn(),
}));
const registryMock = vi.hoisted(() => ({ registry: null as unknown }));
const projectMock = vi.hoisted(() => ({
  getProjectById: vi.fn((id: string): unknown => ({ id, name: id })),
}));

vi.mock("../../NotificationService.js", () => ({ notificationService: notificationServiceMock }));
vi.mock("../../AgentNotificationService.js", () => ({ agentNotificationService: muteMock }));
vi.mock("../../ProjectStore.js", () => ({
  projectStore: {
    getEffectiveNotificationSettings: () => settingsMock.settings,
    getProjectById: projectMock.getProjectById,
  },
}));
vi.mock("../../../../shared/utils/quietHours.js", () => quietMock);
vi.mock("../../../window/projectOwnership.js", () => ownershipMock);
vi.mock("../../../window/windowRef.js", () => ({
  getWindowRegistry: () => registryMock.registry,
}));

import {
  pagePluginNotification,
  _resetPluginNotificationPagerForTests,
  type PluginNotificationPage,
} from "../pluginNotificationPager.js";
import { CHANNELS } from "../../../ipc/channels.js";

const page = (overrides: Partial<PluginNotificationPage> = {}): PluginNotificationPage => ({
  pluginId: "acme",
  projectId: null,
  title: "Acme: Run needs you",
  body: "Approve",
  ...overrides,
});

function viewOf(projectId: string, id: number) {
  return { projectId, view: { webContents: { id, isDestroyed: () => false } } };
}

function clickLastBanner(): void {
  const options = notificationServiceMock.showNativeNotification.mock.calls.at(-1)![2] as {
    onClick: () => void;
  };
  options.onClick();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  _resetPluginNotificationPagerForTests();
  settingsMock.settings = { enabled: true };
  quietMock.isScheduledQuietNow.mockReturnValue(false);
  muteMock.isSessionMuted.mockReturnValue(false);
  notificationServiceMock.isWindowFocused.mockReturnValue(false);
  notificationServiceMock.isOwnerViewFocused.mockReturnValue(false);
  ownershipMock.findOtherProjectOwner.mockReturnValue(null);
  registryMock.registry = { all: () => [], getPrimary: () => undefined };
});

describe("pagePluginNotification", () => {
  it("shows a keyed banner with a main-side click handler and no buttons", () => {
    expect(pagePluginNotification(page({ replaceKey: "plugin:acme:k" }))).toBe(true);

    const [title, body, options] = notificationServiceMock.showNativeNotification.mock.calls[0]!;
    expect([title, body]).toEqual(["Acme: Run needs you", "Approve"]);
    expect(options).toMatchObject({ category: "info", replaceKey: "plugin:acme:k" });
    expect(options).not.toHaveProperty("actions");
    expect(typeof (options as { onClick: unknown }).onClick).toBe("function");
  });

  it.each([
    ["notifications are off", () => (settingsMock.settings = { enabled: false })],
    ["it is quiet hours", () => quietMock.isScheduledQuietNow.mockReturnValue(true)],
    ["the session is muted", () => muteMock.isSessionMuted.mockReturnValue(true)],
    ["a window is focused", () => notificationServiceMock.isWindowFocused.mockReturnValue(true)],
  ])("holds the banner back when %s, but still retires the one it replaces", (_name, arrange) => {
    arrange();

    expect(pagePluginNotification(page({ replaceKey: "plugin:acme:k" }))).toBe(false);

    expect(notificationServiceMock.showNativeNotification).not.toHaveBeenCalled();
    expect(notificationServiceMock.closeNotificationByKey).toHaveBeenCalledWith("plugin:acme:k");
  });

  it("holds a project plugin's banner back only while a view of its project is in front", () => {
    registryMock.registry = {
      all: () => [
        {
          services: {
            projectViewManager: { getAllViews: () => [viewOf("p1", 11), viewOf("p2", 12)] },
          },
        },
      ],
      getPrimary: () => undefined,
    };
    notificationServiceMock.isOwnerViewFocused.mockImplementation((id: number) => id === 12);

    expect(pagePluginNotification(page({ projectId: "p2" }))).toBe(false);
    expect(pagePluginNotification(page({ projectId: "p1" }))).toBe(true);
  });

  it("pages a burst of three, then one every ten seconds per plugin", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const results = Array.from({ length: 4 }, () => pagePluginNotification(page()));
    expect(results).toEqual([true, true, true, false]);
    expect(pagePluginNotification(page({ pluginId: "other" }))).toBe(true);

    vi.setSystemTime(10_000);
    expect(pagePluginNotification(page())).toBe(true);
    expect(pagePluginNotification(page())).toBe(false);
  });

  it("brings a project plugin's project forward and runs the first action on click", () => {
    const owner = { state: "cached" };
    ownershipMock.findOtherProjectOwner.mockReturnValue(owner);
    pagePluginNotification(
      page({ projectId: "p1", firstAction: { actionId: "acme.openRun", args: { runId: "r1" } } })
    );

    clickLastBanner();

    expect(ownershipMock.redirectToProjectOwner).toHaveBeenCalledWith(
      owner,
      { id: "p1", name: "p1" },
      {
        intent: "run-plugin-action",
        pluginId: "acme",
        actionId: "acme.openRun",
        args: { runId: "r1" },
      }
    );
  });

  it("opens nothing when the project has no live view anywhere", () => {
    pagePluginNotification(page({ projectId: "p1", firstAction: { actionId: "acme.openRun" } }));

    clickLastBanner();

    expect(ownershipMock.redirectToProjectOwner).not.toHaveBeenCalled();
  });

  it("sends an app-wide plugin's first action to the primary window's active view", () => {
    const send = vi.fn();
    const focus = vi.fn();
    const browserWindow = { isDestroyed: () => false };
    registryMock.registry = {
      all: () => [],
      getPrimary: () => ({
        browserWindow,
        services: {
          projectViewManager: {
            getActiveView: () => ({ webContents: { isDestroyed: () => false, send, focus } }),
          },
        },
      }),
    };
    pagePluginNotification(page({ firstAction: { actionId: "acme.openRun" } }));

    clickLastBanner();

    expect(ownershipMock.revealWindow).toHaveBeenCalledWith(browserWindow);
    expect(send).toHaveBeenCalledWith(CHANNELS.PROJECT_FOCUS_ON_ACTIVATE, {
      intent: "run-plugin-action",
      pluginId: "acme",
      actionId: "acme.openRun",
    });
  });
});
