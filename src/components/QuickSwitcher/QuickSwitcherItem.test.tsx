// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickSwitcherItem, pathTail } from "./QuickSwitcherItem";
import type { QuickSwitcherItem as QuickSwitcherItemData } from "@/hooks/useQuickSwitcher";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { SESSION_COLORS } from "@/components/Worktree/terminalStateConfig";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: () => <span data-testid="terminal-icon" />,
}));

vi.mock("@/components/icons", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/icons")>()),
  FolderGit2: () => <span data-testid="folder-icon" />,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function makeWorktreeItem(overrides: Partial<QuickSwitcherItemData> = {}): QuickSwitcherItemData {
  return {
    id: "worktree:wt-1",
    type: "worktree",
    title: "main",
    subtitle: "/path/to/wt",
    ...overrides,
  };
}

describe("QuickSwitcherItem", () => {
  const onSelect = vi.fn();

  it("applies selection styling via aria-selected variants", () => {
    const { container } = render(
      <QuickSwitcherItem item={makeWorktreeItem()} isSelected={true} onSelect={onSelect} />
    );

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-selected")).toBe("true");
  });

  it("does not branch styling on isSelected — selection is purely aria-driven", () => {
    const { container: selectedContainer } = render(
      <QuickSwitcherItem item={makeWorktreeItem()} isSelected={true} onSelect={onSelect} />
    );
    const { container: unselectedContainer } = render(
      <QuickSwitcherItem item={makeWorktreeItem()} isSelected={false} onSelect={onSelect} />
    );

    expect(selectedContainer.querySelector("button")?.className).toBe(
      unselectedContainer.querySelector("button")?.className
    );
  });

  it("calls onHover on pointer move", () => {
    const onHover = vi.fn();
    const { container } = render(
      <QuickSwitcherItem
        item={makeWorktreeItem()}
        isSelected={false}
        onSelect={onSelect}
        onHover={onHover}
      />
    );

    fireEvent.pointerMove(container.querySelector("button")!);
    expect(onHover).toHaveBeenCalledTimes(1);
  });
});

describe("pathTail", () => {
  it("keeps the segments that differ between worktrees and drops the shared prefix", () => {
    const a = pathTail("/Users/me/Projects/app-worktrees/feature-login");
    const b = pathTail("/Users/me/Projects/app-worktrees/fix-crash");
    expect(a).not.toBe(b);
    expect(a.endsWith("app-worktrees/feature-login")).toBe(true);
    expect(a).not.toContain("/Users/me");
  });

  it("leaves a path already short enough to read alone", () => {
    expect(pathTail("/repo")).toBe("/repo");
  });
});

describe("QuickSwitcherItem path evidence", () => {
  it("keeps a match in the shortened path marked, on the same characters", () => {
    const path = "/Users/me/Projects/app-worktrees/feature-login";
    const start = path.indexOf("login");
    const { container } = render(
      <QuickSwitcherItem
        item={makeWorktreeItem({ title: "feature/login", subtitle: path })}
        isSelected={false}
        onSelect={() => {}}
        matches={[{ key: "subtitle", indices: [[start, start + 4]], value: path }]}
      />
    );
    const marked = Array.from(container.querySelectorAll("span"))
      .filter((el) => el.children.length === 0 && el.className.includes("bg-overlay-medium"))
      .map((el) => el.textContent);
    expect(marked).toEqual(["login"]);
  });
});

describe("QuickSwitcherItem custom worktree title", () => {
  const path = "/Users/me/Projects/app-worktrees/wt-red";
  const marked = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("span"))
      .filter((el) => el.children.length === 0 && el.className.includes("bg-overlay-medium"))
      .map((el) => el.textContent);
  // The qualifier is the one span in the headline line that caps its own width.
  const qualifier = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('span[class*="max-w-[50%]"]');
  const headline = (container: HTMLElement) =>
    container.querySelector<HTMLElement>("span.font-medium");

  function titled(overrides: Partial<QuickSwitcherItemData> = {}) {
    return makeWorktreeItem({
      title: "Release planning",
      subtitle: path,
      branchLabel: "feature/auth-refresh",
      displaced: "feature/auth-refresh",
      ...overrides,
    });
  }

  const renderRow = (item: QuickSwitcherItemData, extra: Record<string, unknown> = {}) =>
    render(<QuickSwitcherItem item={item} isSelected={false} onSelect={() => {}} {...extra} />);

  it("shows the title, the branch it displaced beside it, and the path under it", () => {
    const { container } = renderRow(titled());
    expect(headline(container)?.textContent).toBe("Release planning");
    expect(qualifier(container)?.textContent).toContain("feature/auth-refresh");
    // The detail line is the shortened path; the mocked tooltip carries the full one.
    const detail = Array.from(container.querySelectorAll("div")).find((el) =>
      el.className.includes("mt-0.5")
    );
    expect(detail?.textContent).toContain("wt-red");
    expect(detail?.textContent).not.toContain("/Users/me");
  });

  it("sets a custom title as a name and a bare branch as the mono identifier it is", () => {
    const custom = renderRow(titled());
    expect(headline(custom.container)?.className).not.toContain("font-mono");
    custom.unmount();
    const bare = renderRow(
      makeWorktreeItem({ title: "feature/auth-refresh", branchLabel: "feature/auth-refresh" })
    );
    expect(headline(bare.container)?.className).toContain("font-mono");
  });

  it("marks a literal match on what the title displaced, with no Fuse ranges at all", () => {
    // A detached row's qualifier is not its branch label, so this reads the rendered text.
    const { container } = renderRow(
      titled({ displaced: "detached at 0123456", branchLabel: "feature/auth-refresh" }),
      { query: "0123456" }
    );
    expect(qualifier(container)?.querySelector(".bg-overlay-medium")?.textContent).toBe("0123456");
    expect(marked(container)).toEqual(["0123456"]);
  });

  it("marks a fuzzy match on the displaced branch on the branch, never on the title", () => {
    const { container } = renderRow(titled(), {
      query: "authrefresh",
      matches: [{ key: "displaced", indices: [[8, 11]], value: "feature/auth-refresh" }],
    });
    expect(marked(container)).toEqual(["auth"]);
    expect(qualifier(container)?.querySelectorAll(".bg-overlay-medium")).toHaveLength(1);
  });

  it("marks a fuzzy match on the title on the title, and keeps title and branch ranges apart", () => {
    const { container } = renderRow(
      titled({ title: "Auth refresh notes", displaced: "feature/auth-refresh" }),
      {
        query: "authrefresh",
        matches: [
          { key: "title", indices: [[0, 3]], value: "Auth refresh notes" },
          { key: "displaced", indices: [[8, 11]], value: "feature/auth-refresh" },
        ],
      }
    );
    expect(headline(container)?.querySelectorAll(".bg-overlay-medium")).toHaveLength(1);
    expect(marked(container)).toEqual(["Auth", "auth"]);
    expect(qualifier(container)?.querySelector(".bg-overlay-medium")?.textContent).toBe("auth");
  });

  it("keeps main's branch qualifier when it has no custom title", () => {
    const { container } = renderRow(
      makeWorktreeItem({ title: "daintree", isMainWorktree: true, branchLabel: "develop" })
    );
    expect(qualifier(container)?.textContent).toContain("develop");
  });

  it("gives an untitled linked worktree no qualifier, whatever its branch label says", () => {
    const { container } = renderRow(
      makeWorktreeItem({ title: "billing-dir", branchLabel: "feature/billing" })
    );
    expect(qualifier(container)).toBeNull();
    expect(container.textContent).not.toContain("feature/billing");
  });

  it("adds no qualifier when the title is the branch itself, for linked and main alike", () => {
    const linked = renderRow(
      makeWorktreeItem({ title: "feature/auth", branchLabel: "feature/auth" })
    );
    expect(qualifier(linked.container)).toBeNull();
    linked.unmount();
    const main = renderRow(
      makeWorktreeItem({ title: "develop", isMainWorktree: true, branchLabel: "develop" })
    );
    expect(qualifier(main.container)).toBeNull();
  });

  it("does not fall back to main's branch when a custom title displaced nothing", () => {
    const { container } = renderRow(
      makeWorktreeItem({
        title: "detached at 0123456",
        isMainWorktree: true,
        branchLabel: "daintree",
        displaced: null,
      })
    );
    expect(qualifier(container)).toBeNull();
  });
});

// The terminal row's state mark is the pane's own glyph (#16057): amber only
// for an unread Canopy ask, never for a prompt that asks nothing.
describe("QuickSwitcherItem agent mark from the fleet band", () => {
  afterEach(() => {
    useFleetSnapshotStore.setState({ snapshot: null });
  });

  function deliverRun(overrides: Partial<FleetRunRow>) {
    act(() => {
      useFleetSnapshotStore.getState().applySnapshot({
        runs: [
          {
            runId: "t1",
            workspaceId: "p1",
            spawnedAt: 1,
            cwd: "/repo",
            agentState: "waiting",
            ...overrides,
          },
        ],
        changedAt: 2,
        degraded: false,
        lastSuccessfulAt: 2,
      });
    });
  }

  const terminalItem: QuickSwitcherItemData = {
    id: "terminal:t1",
    type: "terminal",
    title: "Claude",
    terminalKind: "terminal",
    chrome: deriveTerminalChrome({ launchAgentId: "claude" }),
    agentState: "waiting",
  };
  const mark = (container: HTMLElement) =>
    [...container.querySelectorAll(".sr-only")].map((el) => el.textContent).join("");
  // The row's only svg is its state glyph: the kind icon is stubbed.
  const glyphClass = (container: HTMLElement) =>
    container.querySelector("svg")?.getAttribute("class") ?? null;

  it("names a prompt that asks nothing with no state, and an unread ask waiting", () => {
    const { container } = render(
      <QuickSwitcherItem item={terminalItem} isSelected={false} onSelect={vi.fn()} />
    );
    deliverRun({});
    expect(mark(container)).not.toMatch(/agent/);
    expect(glyphClass(container)).toBeNull();
    deliverRun({ canopy: { kind: "asked", quote: "Run it?", readAt: 1, seen: false } });
    expect(mark(container)).toContain(", agent waiting");
    expect(glyphClass(container)).toContain(SESSION_COLORS.waiting);
  });

  it("names a hand-back unread, then finished once read", () => {
    const { container } = render(
      <QuickSwitcherItem item={terminalItem} isSelected={false} onSelect={vi.fn()} />
    );
    deliverRun({ handBack: { stoppedAt: 1 } });
    expect(mark(container)).toContain(", agent unread");
    expect(glyphClass(container)).toContain(SESSION_COLORS.unread);
    deliverRun({ handBack: { stoppedAt: 1, seenAt: 2 } });
    expect(mark(container)).toContain(", agent finished");
    expect(glyphClass(container)).toContain(SESSION_COLORS.completed);
    expect(glyphClass(container)).not.toContain(SESSION_COLORS.waiting);
  });
});
