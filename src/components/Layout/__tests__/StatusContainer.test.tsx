// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AlertCircle } from "lucide-react";
import type { PtyPanelData } from "@shared/types/panel";
import { StatusContainer, type StatusContainerConfig } from "../StatusContainer";

vi.mock("@/hooks/useWorktrees", () => ({
  useWorktrees: () => ({
    worktreeMap: new Map([
      ["wt-1", { id: "wt-1", name: "feature-auth" }],
      ["wt-2", { id: "wt-2", name: "feature-ui" }],
    ]),
  }),
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
});
