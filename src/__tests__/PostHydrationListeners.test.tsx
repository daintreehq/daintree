/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { PostHydrationListeners } from "@/components/PostHydrationListeners";
import { PERF_MARKS } from "@shared/perf/marks";

const hibernation = vi.fn();
const idleTerminal = vi.fn();
const diskSpace = vi.fn();
const tokenHealth = vi.fn();
const rateLimit = vi.fn();
const recipeFocus = vi.fn();
const devServerSync = vi.fn();
const soundPlayback = vi.fn();
const storeUpdate = vi.fn();
const mark = vi.fn();

vi.mock("@/hooks/useHibernationNotifications", () => ({
  useHibernationNotifications: () => hibernation(),
}));
vi.mock("@/hooks/useIdleTerminalNotifications", () => ({
  useIdleTerminalNotifications: () => idleTerminal(),
}));
vi.mock("@/hooks/useDiskSpaceWarnings", () => ({
  useDiskSpaceWarnings: () => diskSpace(),
}));
vi.mock("@/hooks/useGitHubTokenHealth", () => ({
  useGitHubTokenHealth: () => tokenHealth(),
}));
vi.mock("@/hooks/useGitHubRateLimit", () => ({
  useGitHubRateLimit: () => rateLimit(),
}));
vi.mock("@/hooks/useSoundPlaybackListener", () => ({
  useSoundPlaybackListener: () => soundPlayback(),
}));
vi.mock("@/hooks/useStoreUpdateListener", () => ({
  useStoreUpdateListener: () => storeUpdate(),
}));
vi.mock("@/hooks/app", () => ({
  useRecipeFocusReload: () => recipeFocus(),
  useWorktreeDevServerStateSync: () => devServerSync(),
}));
vi.mock("@/utils/performance", () => ({
  markRendererPerformance: (name: string) => mark(name),
}));

const allHooks = [
  hibernation,
  idleTerminal,
  diskSpace,
  tokenHealth,
  rateLimit,
  recipeFocus,
  devServerSync,
  soundPlayback,
  storeUpdate,
];

describe("PostHydrationListeners", () => {
  afterEach(() => {
    cleanup();
    allHooks.forEach((h) => h.mockClear());
    mark.mockClear();
  });

  it("runs every deferred listener hook once on mount", () => {
    render(<PostHydrationListeners />);

    for (const hook of allHooks) {
      expect(hook).toHaveBeenCalledTimes(1);
    }
  });

  it("emits the staged-mount perf mark exactly once on mount", () => {
    render(<PostHydrationListeners />);

    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith(PERF_MARKS.POST_HYDRATION_LISTENERS_MOUNT);
  });

  it("does not run any deferred hook when it is never rendered (the gate)", () => {
    const isStateLoaded = false;
    render(<>{isStateLoaded && <PostHydrationListeners />}</>);

    for (const hook of allHooks) {
      expect(hook).not.toHaveBeenCalled();
    }
    expect(mark).not.toHaveBeenCalled();
  });

  it("renders nothing visible", () => {
    const { container } = render(<PostHydrationListeners />);
    expect(container.firstChild).toBeNull();
  });
});
