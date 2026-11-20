// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import type { ForgeCheckRun } from "@shared/types/ipc/forge";
import { checkRowLabel } from "@/components/Worktree/ReviewHub/prChecks";
import type { LauncherPullRequest } from "@/hooks/useLinksLauncher";

const h = vi.hoisted(() => ({
  getChecks: vi.fn<(cwd: string, prNumber: number) => Promise<{ checks: ForgeCheckRun[] } | null>>(
    () => Promise.resolve({ checks: [] })
  ),
}));

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: {
    getChecks: (cwd: string, prNumber: number) => h.getChecks(cwd, prNumber),
  },
}));
vi.mock("@/components/Worktree/ReviewHub/usePullRequestTerm", () => ({
  usePullRequestTerm: () => "pull-request",
}));

const { LinksLauncherPullRequest, launcherCheckRows, useLauncherPullRequestChecks } =
  await import("../LinksLauncherPullRequest");

const PR: LauncherPullRequest = {
  worktreeId: "wt-1",
  worktreePath: "/repo/wt-1",
  worktreeLabel: "feature/login",
  providerId: "github.github",
  number: 42,
  url: "https://github.com/acme/app/pull/42",
  title: "Fix login",
  state: "open",
};

const run = (overrides: Partial<ForgeCheckRun>): ForgeCheckRun => ({
  name: "build",
  status: "completed",
  conclusion: "failure",
  detailsUrl: "https://ci.example.com/build",
  ...overrides,
});

beforeEach(() => {
  h.getChecks.mockReset();
  h.getChecks.mockImplementation(() => Promise.resolve({ checks: [] }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("launcherCheckRows", () => {
  it("keeps failing and running checks that have a safe page, failures first", () => {
    const rows = launcherCheckRows([
      run({ name: "e2e", status: "in_progress", conclusion: undefined }),
      run({ name: "lint", conclusion: "success" }),
      run({ name: "unit" }),
      run({ name: "docs", detailsUrl: undefined }),
      run({ name: "smoke", detailsUrl: "javascript:alert(1)" }),
      run({ name: "deploy", conclusion: "cancelled" }),
    ]);
    expect(rows.map((row) => [checkRowLabel(row), row.detailsUrl])).toEqual([
      ["unit", "https://ci.example.com/build"],
      ["e2e", "https://ci.example.com/build"],
    ]);
  });

  it("qualifies a name another workflow shares, even when that one passed", () => {
    const rows = launcherCheckRows([
      run({ name: "build", workflow: "Release", conclusion: "success" }),
      run({ name: "build", workflow: "CI" }),
    ]);
    expect(rows.map(checkRowLabel)).toEqual(["CI / build"]);
  });
});

describe("useLauncherPullRequestChecks", () => {
  it("asks the forge once for an opening StrictMode mounts twice", async () => {
    const { result } = renderHook(() => useLauncherPullRequestChecks(PR, 7), {
      wrapper: StrictMode,
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(h.getChecks).toHaveBeenCalledTimes(1);
    expect(h.getChecks).toHaveBeenCalledWith("/repo/wt-1", 42);
    expect(result.current).toEqual({ kind: "loaded", rows: [] });
  });

  it("reads nothing while closed", async () => {
    const { result } = renderHook(() => useLauncherPullRequestChecks(PR, null));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(h.getChecks).not.toHaveBeenCalled();
    expect(result.current).toEqual({ kind: "idle" });
  });

  it("reads again when the same number comes from another repository", async () => {
    let pullRequest = PR;
    const { rerender } = renderHook(() => useLauncherPullRequestChecks(pullRequest, 7));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    pullRequest = { ...PR, url: "https://github.com/acme/fork/pull/42" };
    rerender();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(h.getChecks).toHaveBeenCalledTimes(2);
  });
});

describe("LinksLauncherPullRequest loading", () => {
  function section(checks: Parameters<typeof LinksLauncherPullRequest>[0]["checks"]) {
    return (
      <LinksLauncherPullRequest
        pullRequest={PR}
        checks={checks}
        sectionId="s"
        onOpen={() => {}}
        onOpenExternal={() => {}}
      />
    );
  }

  it("holds a slow read's skeleton through its floor before the checks", () => {
    vi.useFakeTimers();
    const { rerender } = render(section({ kind: "loading" }));
    expect(screen.queryByRole("status", { name: "Loading checks" })).toBeNull();

    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("status", { name: "Loading checks" })).toBeTruthy();

    rerender(section({ kind: "loaded", rows: launcherCheckRows([run({ name: "unit" })]) }));
    expect(screen.queryByText("unit")).toBeNull();

    act(() => vi.advanceTimersByTime(250));
    expect(screen.queryByRole("status", { name: "Loading checks" })).toBeNull();
    expect(screen.getByText("unit")).toBeTruthy();
  });

  it("holds the failure back until the floor ends, then announces it", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(section({ kind: "loading" }));
    // The region is there, empty, before anything lands in it: a live region
    // mounted together with its text is never announced.
    const region = container.querySelector<HTMLElement>(
      '[role="status"][aria-live="polite"]:not([aria-label])'
    );
    expect(region?.textContent).toBe("");
    act(() => vi.advanceTimersByTime(200));
    rerender(section({ kind: "error" }));
    expect(screen.queryByText("Couldn't load checks")).toBeNull();

    act(() => vi.advanceTimersByTime(250));
    expect(region?.isConnected).toBe(true);
    expect(region?.textContent).toBe("Couldn't load checks");
  });

  it("shows a quick answer without any skeleton", () => {
    vi.useFakeTimers();
    const { rerender } = render(section({ kind: "loading" }));
    rerender(section({ kind: "loaded", rows: launcherCheckRows([run({ name: "unit" })]) }));
    expect(screen.queryByRole("status", { name: "Loading checks" })).toBeNull();
    expect(screen.getByText("unit")).toBeTruthy();
  });
});
