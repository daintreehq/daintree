// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { AlertCircle } from "lucide-react";
import type { PtyPanelData } from "@shared/types/panel";
import { StatusContainer, type StatusContainerConfig } from "../StatusContainer";
import { DockFocusLandmarkContext } from "../dockFocusHandoff";

vi.mock("@/hooks/useWorktrees", () => ({
  useWorktreeNames: () =>
    new Map([
      ["wt-1", "feature-auth"],
      ["wt-2", "feature-ui"],
    ]),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (s: unknown) => unknown) =>
    selector({ activeWorktreeId: "wt-1", selectWorktree: vi.fn(), trackTerminalFocus: vi.fn() }),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: () => null,
}));

vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({
    terminalId,
    proxy,
    children,
  }: {
    terminalId: string;
    proxy?: boolean;
    children: React.ReactNode;
  }) => (
    <div data-testid="terminal-menu" data-terminal-id={terminalId} data-proxy={String(!!proxy)}>
      {children}
    </div>
  ),
}));

const config: StatusContainerConfig = {
  icon: AlertCircle,
  iconColor: "text-status-error",
  headerLabel: "Errors",
  buttonLabel: "Errors",
  statusAriaLabel: "Error",
  contentAriaLabel: "Errored panels",
  contentId: "errors-popover",
};

function makeTerminal(id: string, title: string, worktreeId: string): PtyPanelData {
  return {
    id,
    title,
    worktreeId,
    kind: "terminal",
    location: "grid",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
  } as PtyPanelData;
}

describe("StatusContainer", () => {
  it("splits rows by worktree and names the worktree only under other worktrees", () => {
    render(
      <StatusContainer
        config={config}
        terminals={[
          makeTerminal("t1", "Local", "wt-1"),
          makeTerminal("t2", "Remote", "wt-2"),
          makeTerminal("t3", "Also local", "wt-1"),
        ]}
      />
    );

    const here = screen.getByRole("group", { name: "This worktree" }).textContent ?? "";
    const away = screen.getByRole("group", { name: "Other worktrees" }).textContent ?? "";
    expect(here).toContain("Local");
    expect(here).toContain("Also local");
    expect(here).not.toContain("feature-auth");
    expect(away).toContain("Remote");
    expect(away).toContain("feature-ui");
  });

  it("omits a section with nothing in it", () => {
    render(<StatusContainer config={config} terminals={[makeTerminal("t2", "Remote", "wt-2")]} />);
    expect(screen.queryByRole("group", { name: "This worktree" })).toBeNull();
    expect(screen.getByRole("group", { name: "Other worktrees" })).toBeTruthy();
  });

  it("wraps each row in the terminal context menu as a proxy", () => {
    render(
      <StatusContainer
        config={config}
        terminals={[makeTerminal("t1", "Local", "wt-1"), makeTerminal("t2", "Remote", "wt-2")]}
      />
    );
    const menus = screen.getAllByTestId("terminal-menu");
    expect(menus.map((m) => m.getAttribute("data-terminal-id")).sort()).toEqual(["t1", "t2"]);
    for (const m of menus) {
      expect(m.getAttribute("data-proxy")).toBe("true");
      expect(m.querySelector("button[data-dock-row]")).not.toBeNull();
    }
  });
});

describe("StatusContainer — focus when the pill hides (#16921)", () => {
  const handoff = vi.fn();
  const landmarkEl = document.createElement("button");
  const withDock = (terminals: PtyPanelData[]) => (
    <DockFocusLandmarkContext.Provider value={{ handoff, resolve: () => landmarkEl }}>
      <input data-testid="outside" />
      <StatusContainer config={config} terminals={terminals} />
    </DockFocusLandmarkContext.Provider>
  );
  const trigger = (container: HTMLElement) =>
    container.querySelector<HTMLElement>("button[aria-haspopup='dialog']")!;
  const insideControl = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>("button")).find(
      (button) => button !== trigger(container)
    )!;
  const one = () => [makeTerminal("t1", "Local", "wt-1")];

  beforeEach(() => handoff.mockClear());

  it("hands focus to the dock when the last errored panel clears under a focused trigger", () => {
    const view = render(withDock(one()));
    act(() => trigger(view.container).focus());

    view.rerender(withDock([]));

    expect(view.container.querySelector(".dock-status-pill")?.getAttribute("data-visible")).toBe(
      "false"
    );
    expect(handoff).toHaveBeenCalledTimes(1);
  });

  it("tracks focus on a row of the popover, not only on the trigger", () => {
    const view = render(withDock(one()));
    act(() => insideControl(view.container).focus());

    view.rerender(withDock([]));

    expect(handoff).toHaveBeenCalledTimes(1);
  });

  it("keeps focus while the count falls but the pill stays", () => {
    const view = render(withDock([...one(), makeTerminal("t2", "Other", "wt-1")]));
    act(() => trigger(view.container).focus());

    view.rerender(withDock(one()));

    expect(handoff).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger(view.container));
  });

  it("leaves focus where the user put it", () => {
    const view = render(withDock(one()));
    act(() => trigger(view.container).focus());
    act(() => screen.getByTestId("outside").focus());

    view.rerender(withDock([]));

    expect(handoff).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByTestId("outside"));
  });
});
