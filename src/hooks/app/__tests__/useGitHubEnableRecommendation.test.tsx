// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  useGitHubEnableRecommendation,
  _resetGitHubEnableRecommendationForTest,
} from "../useGitHubEnableRecommendation";

const notifyMock = vi.hoisted(() => vi.fn((_payload: unknown) => "notif-1"));

interface NotifiedPayload {
  actions: Array<{ label: string; onClick: () => void }>;
}

function lastNotifyPayload(): NotifiedPayload {
  const payload = notifyMock.mock.calls.at(-1)?.[0];
  if (!payload) throw new Error("notify was not called");
  return payload as NotifiedPayload;
}
const removeNotificationMock = vi.hoisted(() => vi.fn());
const currentProjectRef = vi.hoisted(() => ({ value: null as { path: string } | null }));

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { currentProject: { path: string } | null }) => unknown) =>
    selector({ currentProject: currentProjectRef.value }),
}));
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: (selector: (s: { removeNotification: () => void }) => unknown) =>
    selector({ removeNotification: removeNotificationMock }),
}));
vi.mock("../useElectron", () => ({ isElectronAvailable: () => true }));
vi.mock("@/utils/safeFireAndForget", () => ({
  safeFireAndForget: (p: Promise<unknown>) => void p.catch(() => {}),
}));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

const listMock = vi.fn();
const listRemotesMock = vi.fn();
const setEnabledMock = vi.fn(async () => {});

function installElectronMocks(opts: { githubDisabled: boolean; remotes: string[] }) {
  listMock.mockResolvedValue([
    { manifest: { name: "daintree.github" }, disabled: opts.githubDisabled },
  ]);
  listRemotesMock.mockResolvedValue(opts.remotes.map((fetchUrl) => ({ fetchUrl })));
  window.electron = {
    plugin: { list: listMock, setEnabled: setEnabledMock },
    project: { listRemotes: listRemotesMock },
  } as unknown as typeof window.electron;
}

beforeEach(() => {
  vi.clearAllMocks();
  notifyMock.mockReturnValue("notif-1");
  _resetGitHubEnableRecommendationForTest();
  currentProjectRef.value = { path: "/Users/test/Projects/sample" };
});

describe("useGitHubEnableRecommendation", () => {
  it("recommends once for a github.com repo while the plugin is disabled", async () => {
    installElectronMocks({
      githubDisabled: true,
      remotes: ["git@github.com:owner/repo.git"],
    });

    const { rerender } = renderHook(() => useGitHubEnableRecommendation(true));

    await waitFor(() => {
      expect(notifyMock).toHaveBeenCalledTimes(1);
    });
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ placement: "grid-bar", title: "GitHub integration is off" })
    );

    // Same project re-render: no duplicate nudge.
    rerender();
    await new Promise((r) => setTimeout(r, 0));
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("never fires when the plugin is enabled", async () => {
    installElectronMocks({
      githubDisabled: false,
      remotes: ["git@github.com:owner/repo.git"],
    });

    renderHook(() => useGitHubEnableRecommendation(true));

    await waitFor(() => expect(listMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("never fires for a non-GitHub remote", async () => {
    installElectronMocks({
      githubDisabled: true,
      remotes: ["git@gitlab.com:owner/repo.git"],
    });

    renderHook(() => useGitHubEnableRecommendation(true));

    await waitFor(() => expect(listRemotesMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("enables only on the explicit action click, never autonomously", async () => {
    installElectronMocks({
      githubDisabled: true,
      remotes: ["https://github.com/owner/repo.git"],
    });

    renderHook(() => useGitHubEnableRecommendation(true));
    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));

    // The hook itself must never flip the toggle.
    expect(setEnabledMock).not.toHaveBeenCalled();

    const enableAction = lastNotifyPayload().actions.find((a) => a.label === "Enable GitHub");
    expect(enableAction).toBeDefined();
    enableAction?.onClick();
    expect(setEnabledMock).toHaveBeenCalledWith("daintree.github", true);
    expect(removeNotificationMock).toHaveBeenCalledWith("notif-1");
  });

  it("does not re-fire for a project dismissed this session", async () => {
    installElectronMocks({
      githubDisabled: true,
      remotes: ["git@github.com:owner/repo.git"],
    });

    const { unmount } = renderHook(() => useGitHubEnableRecommendation(true));
    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));

    lastNotifyPayload()
      .actions.find((a) => a.label === "Not now")
      ?.onClick();
    unmount();

    renderHook(() => useGitHubEnableRecommendation(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});
