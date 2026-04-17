// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { TrashBinItem } from "../TrashBinItem";
import type { TerminalInstance } from "@/store";
import type { TrashedTerminal } from "@/store/slices";

vi.mock("@/store", () => ({
  usePanelStore: (selector: (s: unknown) => unknown) =>
    selector({ restoreTerminal: vi.fn(), removePanel: vi.fn() }),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (s: unknown) => unknown) =>
    selector({ activeWorktreeId: "wt-active" }),
}));

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: () => null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: { children: React.ReactNode } & React.HTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => {
  const Pass = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return {
    Tooltip: Pass,
    TooltipContent: Pass,
    TooltipProvider: Pass,
    TooltipTrigger: Pass,
  };
});

vi.mock("@shared/config/agentRegistry", () => ({
  getEffectiveAgentConfig: (agentId: string) =>
    agentId === "claude" ? { name: "Claude" } : undefined,
}));

function makeAgentTerminal(overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id: "t1",
    kind: "agent",
    agentId: "claude",
    type: "claude",
    title: "claude",
    location: "trash",
    ...overrides,
  } as TerminalInstance;
}

const trashedInfo: TrashedTerminal = {
  id: "t1",
  expiresAt: Date.now() + 20000,
  originalLocation: "grid",
};

describe("TrashBinItem", () => {
  it("does not duplicate worktree name when the agent title falls back to agent name", () => {
    const terminal = makeAgentTerminal({ title: "claude", lastObservedTitle: undefined });
    const { container } = render(
      <TrashBinItem terminal={terminal} trashedInfo={trashedInfo} worktreeName="feature-auth" />
    );
    const text = container.textContent ?? "";
    const occurrences = text.split("feature-auth").length - 1;
    // The render path appends "(feature-auth)" exactly once — never in the name itself.
    expect(occurrences).toBe(1);
    expect(text).not.toContain("Claude · feature-auth");
    expect(text).toContain("Claude");
    expect(text).toContain("(feature-auth)");
  });

  it("prefers lastObservedTitle over plain title for agent terminals", () => {
    const terminal = makeAgentTerminal({
      title: "claude",
      lastObservedTitle: "Fixing auth bug",
    });
    const { container } = render(
      <TrashBinItem terminal={terminal} trashedInfo={trashedInfo} worktreeName="feature-auth" />
    );
    expect(container.textContent).toContain("Fixing auth bug");
  });

  it("falls back to agent name alone when both titles are useless", () => {
    const terminal = makeAgentTerminal({ title: "claude", lastObservedTitle: "claude" });
    const { container } = render(<TrashBinItem terminal={terminal} trashedInfo={trashedInfo} />);
    expect(container.textContent).toContain("Claude");
  });

  it("passes through a meaningful title on non-agent terminals", () => {
    const terminal = {
      id: "t2",
      kind: "terminal" as const,
      type: "terminal" as const,
      title: "my dev shell",
      location: "trash" as const,
    } as TerminalInstance;
    const { container } = render(<TrashBinItem terminal={terminal} trashedInfo={trashedInfo} />);
    expect(container.textContent).toContain("my dev shell");
  });
});
