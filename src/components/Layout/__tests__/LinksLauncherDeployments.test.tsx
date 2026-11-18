// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { DeploymentTarget } from "@shared/types/forge";
import type { ForgeDeployment } from "@shared/types/ipc/forge";
import type { LauncherDeploymentTarget } from "@/hooks/useLinksLauncher";

type DeploymentsAnswer = { deployments: ForgeDeployment[] } | null;

const h = vi.hoisted(() => ({
  getDeployments: vi.fn<(cwd: string, target: DeploymentTarget) => Promise<DeploymentsAnswer>>(() =>
    Promise.resolve({ deployments: [] })
  ),
  openInPanel: false,
  expectHandoff: vi.fn(),
}));

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: {
    getDeployments: (cwd: string, target: DeploymentTarget) => h.getDeployments(cwd, target),
  },
}));
vi.mock("@/services/openLinkUrl", () => ({
  opensInPanel: () => h.openInPanel,
}));
vi.mock("@/components/ui/overlay-focus-restore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/overlay-focus-restore")>()),
  useOverlayFocusRestore: () => ({ expectHandoff: h.expectHandoff }),
}));

const {
  LinksLauncherDeployments,
  latestLauncherDeployments,
  showsDeployments,
  useLauncherDeployments,
} = await import("../LinksLauncherDeployments");

const PR_TARGET: LauncherDeploymentTarget = {
  worktreeId: "wt-1",
  worktreePath: "/repo/wt-1",
  worktreeLabel: "feature/login",
  providerId: "github.github",
  kind: "pullRequest",
  prNumber: 42,
  prUrl: "https://github.com/acme/app/pull/42",
};

const BRANCH_TARGET: LauncherDeploymentTarget = {
  worktreeId: "wt-1",
  worktreePath: "/repo/wt-1",
  worktreeLabel: "feature/login",
  providerId: "github.github",
  kind: "branch",
  branch: "feature/login",
};

let nextId = 1;
const deployment = (overrides: Partial<ForgeDeployment>): ForgeDeployment => ({
  id: `d${nextId++}`,
  environment: "Preview",
  state: "success",
  createdAt: 1_000,
  updatedAt: 1_000,
  ...overrides,
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  h.getDeployments.mockReset();
  h.getDeployments.mockImplementation(() => Promise.resolve({ deployments: [] }));
  h.openInPanel = false;
  h.expectHandoff.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("latestLauncherDeployments", () => {
  it("takes each environment's state and address from its newest deployment alone", () => {
    const rows = latestLauncherDeployments([
      deployment({
        environment: "Production",
        state: "success",
        url: "https://app.example.com/",
        createdAt: 500,
      }),
      deployment({
        environment: "Preview",
        state: "success",
        url: "https://app-old.example.dev/",
        createdAt: 1_000,
        updatedAt: 3_000,
      }),
      // Still rolling out, with no address yet: never the previous one's.
      deployment({ environment: "Preview", state: "in_progress", createdAt: 2_000 }),
    ]);
    expect(rows.map(({ environment, state, url }) => [environment, state.label, url])).toEqual([
      ["Preview", "Deploying", undefined],
      ["Production", "Deployed", "https://app.example.com/"],
    ]);
  });

  it("keeps the host's order for deployments created together", () => {
    const rows = latestLauncherDeployments([
      deployment({ environment: "web", url: "https://web.example.dev/" }),
      deployment({ environment: "docs", url: "https://docs.example.dev/" }),
      deployment({ environment: "web", state: "failure" }),
    ]);
    expect(rows.map((row) => [row.environment, row.state.label])).toEqual([
      ["web", "Deployed"],
      ["docs", "Deployed"],
    ]);
  });

  it("names every state, keeping a failed or inactive one's own address only", () => {
    const states = ["pending", "in_progress", "success", "failure", "inactive", "unknown"] as const;
    const rows = latestLauncherDeployments(
      states.map((state, index) =>
        deployment({
          environment: state,
          state,
          createdAt: 10 - index,
          ...(state === "failure" || state === "inactive"
            ? { url: `https://${state}.example.dev/` }
            : {}),
        })
      )
    );
    expect(rows.map((row) => [row.environment, row.state.label, row.url])).toEqual([
      ["pending", "Pending", undefined],
      ["in_progress", "Deploying", undefined],
      ["success", "Deployed", undefined],
      ["failure", "Failed", "https://failure.example.dev/"],
      ["inactive", "Inactive", "https://inactive.example.dev/"],
      ["unknown", "Unknown state", undefined],
    ]);
  });

  it("tells environments apart by their exact name, and cleans the name it shows", () => {
    const rows = latestLauncherDeployments([
      deployment({ environment: "Preview – web\n\n" }),
      deployment({ environment: "Preview – web" }),
      deployment({ environment: "\u001b[31m" }),
    ]);
    expect(rows.map((row) => [row.environment, row.name])).toEqual([
      ["Preview – web\n\n", "Preview – web"],
      ["Preview – web", "Preview – web"],
      ["\u001b[31m", "Unnamed environment"],
    ]);
  });

  it("keeps the row but drops an address the renderer won't open", () => {
    // Main passes it (an ordinary https address); it is past the renderer's length cap.
    const long = `https://preview.example.dev/${"a".repeat(2_100)}`;
    const rows = latestLauncherDeployments([
      deployment({ environment: "Preview", state: "failure", url: long }),
    ]);
    expect(rows.map((row) => [row.environment, row.state.label, row.url])).toEqual([
      ["Preview", "Failed", undefined],
    ]);
  });
});

describe("useLauncherDeployments", () => {
  it("asks once for an opening StrictMode mounts twice, by pull request", async () => {
    h.getDeployments.mockResolvedValue({
      deployments: [deployment({ url: "https://preview.example.dev/" })],
    });
    const { result } = renderHook(() => useLauncherDeployments(PR_TARGET, 7), {
      wrapper: StrictMode,
    });
    expect(result.current).toEqual({ kind: "loading" });
    await settle();
    expect(h.getDeployments).toHaveBeenCalledTimes(1);
    expect(h.getDeployments).toHaveBeenCalledWith("/repo/wt-1", {
      kind: "pullRequest",
      prNumber: 42,
    });
    expect(result.current.kind === "loaded" && result.current.rows.map((row) => row.url)).toEqual([
      "https://preview.example.dev/",
    ]);
  });

  it("asks by branch when there is no pull request", async () => {
    renderHook(() => useLauncherDeployments(BRANCH_TARGET, 7));
    await settle();
    expect(h.getDeployments).toHaveBeenCalledWith("/repo/wt-1", {
      kind: "branch",
      branch: "feature/login",
    });
  });

  it("reads nothing while closed, or with nowhere to ask", async () => {
    const closed = renderHook(() => useLauncherDeployments(BRANCH_TARGET, null));
    const nowhere = renderHook(() => useLauncherDeployments(null, 7));
    await settle();
    expect(h.getDeployments).not.toHaveBeenCalled();
    expect(closed.result.current).toEqual({ kind: "idle" });
    expect(nowhere.result.current).toEqual({ kind: "idle" });
  });

  it("has nothing deployed for a target the forge says doesn't exist", async () => {
    h.getDeployments.mockResolvedValue(null);
    const { result } = renderHook(() => useLauncherDeployments(PR_TARGET, 7));
    await settle();
    expect(result.current).toEqual({ kind: "loaded", rows: [] });
  });

  it("owns up to a failed read", async () => {
    h.getDeployments.mockRejectedValue(new Error("rate limited"));
    const { result } = renderHook(() => useLauncherDeployments(PR_TARGET, 7));
    await settle();
    expect(result.current).toEqual({ kind: "error" });
  });

  it("reads again for each opening and each target, keeping a late answer off the new one", async () => {
    let resolveFirst!: (value: DeploymentsAnswer) => void;
    h.getDeployments.mockImplementationOnce(
      () => new Promise<DeploymentsAnswer>((resolve) => (resolveFirst = resolve))
    );
    let target: LauncherDeploymentTarget = PR_TARGET;
    let seq = 7;
    const { result, rerender } = renderHook(() => useLauncherDeployments(target, seq));
    await settle();

    target = BRANCH_TARGET;
    rerender();
    await settle();
    expect(h.getDeployments).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ kind: "loaded", rows: [] });

    await act(async () => {
      resolveFirst({ deployments: [deployment({ url: "https://stale.example.dev/" })] });
    });
    expect(result.current).toEqual({ kind: "loaded", rows: [] });

    seq = 8;
    rerender();
    expect(result.current).toEqual({ kind: "loading" });
    await settle();
    expect(h.getDeployments).toHaveBeenCalledTimes(3);
  });

  it("keeps a late failure for the target before off the new one", async () => {
    let rejectFirst!: (error: unknown) => void;
    h.getDeployments.mockImplementationOnce(
      () => new Promise<DeploymentsAnswer>((_, reject) => (rejectFirst = reject))
    );
    h.getDeployments.mockImplementationOnce(() =>
      Promise.resolve({ deployments: [deployment({ url: "https://signup.example.dev/" })] })
    );
    let target: LauncherDeploymentTarget = PR_TARGET;
    const { result, rerender } = renderHook(() => useLauncherDeployments(target, 7));
    await settle();
    target = BRANCH_TARGET;
    rerender();
    await settle();
    await act(async () => {
      rejectFirst(new Error("rate limited"));
    });
    expect(result.current.kind === "loaded" && result.current.rows.map((row) => row.url)).toEqual([
      "https://signup.example.dev/",
    ]);
  });

  it("waits for a fresh read when a target comes back within one opening", async () => {
    h.getDeployments.mockResolvedValueOnce({
      deployments: [deployment({ url: "https://first-read.example.dev/" })],
    });
    // The branch never answers, so nothing replaces the first read's result
    // before the pull request comes back.
    h.getDeployments.mockImplementation(() => new Promise(() => {}));
    let target: LauncherDeploymentTarget = PR_TARGET;
    const { result, rerender } = renderHook(() => useLauncherDeployments(target, 7));
    await settle();
    expect(result.current.kind).toBe("loaded");

    target = BRANCH_TARGET;
    rerender();
    await settle();
    target = PR_TARGET;
    rerender();
    expect(result.current).toEqual({ kind: "loading" });
    await settle();
    expect(h.getDeployments).toHaveBeenCalledTimes(3);
    expect(result.current).toEqual({ kind: "loading" });
  });

  it("reads again when the same number comes from another repository", async () => {
    let target: LauncherDeploymentTarget = PR_TARGET;
    const { rerender } = renderHook(() => useLauncherDeployments(target, 7));
    await settle();
    target = { ...PR_TARGET, prUrl: "https://github.com/acme/fork/pull/42" };
    rerender();
    await settle();
    expect(h.getDeployments).toHaveBeenCalledTimes(2);
  });
});

describe("showsDeployments", () => {
  it("shows a deployment, a failed read or a skeleton, never an empty answer", () => {
    const rows = latestLauncherDeployments([deployment({})]);
    expect(showsDeployments({ kind: "loaded", rows }, false)).toBe(true);
    expect(showsDeployments({ kind: "error" }, false)).toBe(true);
    expect(showsDeployments({ kind: "loading" }, true)).toBe(true);
    expect(showsDeployments({ kind: "loading" }, false)).toBe(false);
    expect(showsDeployments({ kind: "loaded", rows: [] }, false)).toBe(false);
  });
});

describe("LinksLauncherDeployments", () => {
  function rowsOf(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>("li"));
  }

  it("opens an environment's address, and reads one without an address as plain text", () => {
    const onOpen = vi.fn();
    const rows = latestLauncherDeployments([
      deployment({ environment: "Preview", url: "https://app-git-login.example.dev/?x=1" }),
      deployment({ environment: "Storybook", state: "in_progress" }),
    ]);
    const { container } = render(
      <LinksLauncherDeployments
        worktreeLabel="feature/login"
        deployments={{ kind: "loaded", rows }}
        showSkeleton={false}
        sectionId="s"
        onOpen={onOpen}
      />
    );
    expect(container.querySelector("h2")?.textContent).toBe("Deployments feature/login");
    const [preview, storybook] = rowsOf(container);
    const button = preview!.querySelector("button")!;
    expect(button.getAttribute("aria-describedby")).not.toBeNull();
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Deployed · app-git-login.example.dev"
    );
    expect(storybook!.querySelector("button, a, [role], [tabindex]")).toBeNull();
    expect(storybook!.getAttribute("role")).toBeNull();
    expect(storybook!.getAttribute("tabindex")).toBeNull();
    expect(storybook!.textContent).toBe("StorybookDeploying");

    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledWith("https://app-git-login.example.dev/?x=1");
  });

  it("never hands focus off to a panel, even for a local address", () => {
    const onOpen = vi.fn();
    h.openInPanel = true;
    const rows = latestLauncherDeployments([
      deployment({ environment: "Local", url: "http://localhost:4000/" }),
    ]);
    const { container } = render(
      <LinksLauncherDeployments
        worktreeLabel="feature/login"
        deployments={{ kind: "loaded", rows }}
        showSkeleton={false}
        sectionId="s"
        onOpen={onOpen}
      />
    );
    fireEvent.click(container.querySelector("button")!);
    expect(onOpen).toHaveBeenCalledWith("http://localhost:4000/");
    expect(h.expectHandoff).not.toHaveBeenCalled();
  });

  it("shows no heading for an answer with nothing deployed", () => {
    const { container } = render(
      <LinksLauncherDeployments
        worktreeLabel="feature/login"
        deployments={{ kind: "loaded", rows: [] }}
        showSkeleton={false}
        sectionId="s"
        onOpen={() => {}}
      />
    );
    expect(container.querySelector("h2")).toBeNull();
    expect(container.querySelector("li")).toBeNull();
    expect(container.querySelector("[aria-labelledby]")).toBeNull();
  });

  it("announces a failed read in a region mounted before it lands", () => {
    const props = {
      worktreeLabel: "feature/login",
      showSkeleton: false,
      sectionId: "s",
      onOpen: () => {},
    };
    const { container, rerender } = render(
      <LinksLauncherDeployments {...props} deployments={{ kind: "loading" }} />
    );
    const region = container.querySelector<HTMLElement>('[role="status"][aria-live="polite"]');
    expect(region?.textContent).toBe("");
    rerender(<LinksLauncherDeployments {...props} deployments={{ kind: "error" }} />);
    expect(region?.isConnected).toBe(true);
    expect(region?.textContent).toBe("Couldn't load deployments");
    // Inside the section it belongs to, for whoever comes back to the region.
    expect(
      screen.getByRole("region", { name: "Deployments feature/login" }).contains(region!)
    ).toBe(true);
  });
});
