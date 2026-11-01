// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickSwitcherItem, pathTail } from "./QuickSwitcherItem";
import type { QuickSwitcherItem as QuickSwitcherItemData } from "@/hooks/useQuickSwitcher";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { deriveTerminalChrome } from "@/utils/terminalChrome";

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

  it("names a prompt that asks nothing with no state, and an unread ask waiting", () => {
    const { container } = render(
      <QuickSwitcherItem item={terminalItem} isSelected={false} onSelect={vi.fn()} />
    );
    deliverRun({});
    expect(mark(container)).not.toMatch(/agent/);
    deliverRun({ canopy: { kind: "asked", quote: "Run it?", readAt: 1, seen: false } });
    expect(mark(container)).toContain(", agent waiting");
  });

  it("names a hand-back unread, then finished once read", () => {
    const { container } = render(
      <QuickSwitcherItem item={terminalItem} isSelected={false} onSelect={vi.fn()} />
    );
    deliverRun({ handBack: { stoppedAt: 1 } });
    expect(mark(container)).toContain(", agent unread");
    deliverRun({ handBack: { stoppedAt: 1, seenAt: 2 } });
    expect(mark(container)).toContain(", agent finished");
  });
});
