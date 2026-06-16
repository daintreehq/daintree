// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  useForgeEnableRecommendation,
  _resetForgeEnableRecommendationForTest,
} from "../useForgeEnableRecommendation";

const notifyMock = vi.hoisted(() => vi.fn((_payload: unknown) => "notif-1"));

interface NotifiedPayload {
  title: string;
  message: string;
  supersedeKey: string;
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
const getDismissedMock = vi.fn(async (): Promise<Record<string, true>> => ({}));
const markDismissedMock = vi.fn(async () => {});

interface PluginRow {
  name: string;
  displayName?: string;
  disabled: boolean;
  forgeProviders?: Array<{ id: string; name: string; matches: string[] }>;
}

function installElectronMocks(opts: { plugins: PluginRow[]; remotes: string[] }) {
  listMock.mockResolvedValue(
    opts.plugins.map((p) => ({
      manifest: {
        name: p.name,
        displayName: p.displayName,
        contributes: { forgeProviders: p.forgeProviders ?? [] },
      },
      disabled: p.disabled,
    }))
  );
  listRemotesMock.mockResolvedValue(opts.remotes.map((fetchUrl) => ({ fetchUrl })));
  window.electron = {
    plugin: { list: listMock, setEnabled: setEnabledMock },
    project: { listRemotes: listRemotesMock },
    forgeRecommendation: { getDismissed: getDismissedMock, markDismissed: markDismissedMock },
  } as unknown as typeof window.electron;
}

const githubPlugin = (disabled: boolean): PluginRow => ({
  name: "daintree.github",
  displayName: "GitHub",
  disabled,
  forgeProviders: [{ id: "github", name: "GitHub", matches: ["github.com"] }],
});

beforeEach(() => {
  vi.clearAllMocks();
  notifyMock.mockReturnValue("notif-1");
  getDismissedMock.mockResolvedValue({});
  markDismissedMock.mockResolvedValue(undefined);
  _resetForgeEnableRecommendationForTest();
  currentProjectRef.value = { path: "/Users/test/Projects/sample" };
});

describe("useForgeEnableRecommendation", () => {
  it("recommends once for a repo matching a disabled provider's hostnames", async () => {
    installElectronMocks({
      plugins: [githubPlugin(true)],
      remotes: ["git@github.com:owner/repo.git"],
    });

    const { rerender } = renderHook(() => useForgeEnableRecommendation(true));

    await waitFor(() => {
      expect(notifyMock).toHaveBeenCalledTimes(1);
    });
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "grid-bar",
        title: "GitHub integration is off",
        supersedeKey: "forge-enable-recommendation:daintree.github:/Users/test/Projects/sample",
      })
    );

    // Same project re-render: no duplicate nudge.
    rerender();
    await new Promise((r) => setTimeout(r, 0));
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("never fires when the plugin is enabled", async () => {
    installElectronMocks({
      plugins: [githubPlugin(false)],
      remotes: ["git@github.com:owner/repo.git"],
    });

    renderHook(() => useForgeEnableRecommendation(true));

    await waitFor(() => expect(listMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("never fires when no remote matches the disabled provider", async () => {
    installElectronMocks({
      plugins: [githubPlugin(true)],
      remotes: ["git@gitlab.com:owner/repo.git"],
    });

    renderHook(() => useForgeEnableRecommendation(true));

    await waitFor(() => expect(listRemotesMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("matches hosts strictly — a lookalike host or path segment never counts", async () => {
    installElectronMocks({
      plugins: [githubPlugin(true)],
      remotes: [
        // scp-form host is notgithub.com, not github.com
        "git@notgithub.com:owner/repo.git",
        // path segment contains github.com but the host does not
        "https://mirror.example.com/github.com/owner/repo.git",
      ],
    });

    renderHook(() => useForgeEnableRecommendation(true));

    await waitFor(() => expect(listRemotesMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("recommends a third-party provider plugin using its own names", async () => {
    installElectronMocks({
      plugins: [
        githubPlugin(false),
        {
          name: "acme.gitlab",
          displayName: "Acme GitLab",
          disabled: true,
          forgeProviders: [{ id: "gitlab", name: "GitLab", matches: ["gitlab.example.com"] }],
        },
      ],
      remotes: ["https://gitlab.example.com/owner/repo.git"],
    });

    renderHook(() => useForgeEnableRecommendation(true));

    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));
    const payload = lastNotifyPayload();
    expect(payload.title).toBe("GitLab integration is off");
    expect(payload.message).toContain("hosted on GitLab");
    expect(payload.message).toContain("Acme GitLab plugin is disabled");
    expect(payload.supersedeKey).toBe(
      "forge-enable-recommendation:acme.gitlab:/Users/test/Projects/sample"
    );
    expect(payload.actions.find((a) => a.label === "Enable Acme GitLab")).toBeDefined();
  });

  it("enables only on the explicit action click, never autonomously", async () => {
    installElectronMocks({
      plugins: [githubPlugin(true)],
      remotes: ["https://github.com/owner/repo.git"],
    });

    renderHook(() => useForgeEnableRecommendation(true));
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
      plugins: [githubPlugin(true)],
      remotes: ["git@github.com:owner/repo.git"],
    });

    const { unmount } = renderHook(() => useForgeEnableRecommendation(true));
    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));

    lastNotifyPayload()
      .actions.find((a) => a.label === "Not now")
      ?.onClick();
    unmount();

    renderHook(() => useForgeEnableRecommendation(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("persists the dismissal at evaluation time, not only on a Not now click", async () => {
    installElectronMocks({
      plugins: [githubPlugin(true)],
      remotes: ["git@github.com:owner/repo.git"],
    });

    renderHook(() => useForgeEnableRecommendation(true));

    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));
    // Persisted as soon as the nudge fires — no user click required.
    expect(markDismissedMock).toHaveBeenCalledWith("/Users/test/Projects/sample");
  });

  it("does not re-fire across restart for a path persisted as dismissed", async () => {
    installElectronMocks({
      plugins: [githubPlugin(true)],
      remotes: ["git@github.com:owner/repo.git"],
    });
    // Simulate a fresh session where the path was dismissed previously.
    getDismissedMock.mockResolvedValue({ "/Users/test/Projects/sample": true });

    renderHook(() => useForgeEnableRecommendation(true));

    await waitFor(() => expect(getDismissedMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("falls back to evaluating when reading persisted dismissals fails", async () => {
    installElectronMocks({
      plugins: [githubPlugin(true)],
      remotes: ["git@github.com:owner/repo.git"],
    });
    getDismissedMock.mockRejectedValue(new Error("store unavailable"));

    renderHook(() => useForgeEnableRecommendation(true));

    await waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));
  });
});
