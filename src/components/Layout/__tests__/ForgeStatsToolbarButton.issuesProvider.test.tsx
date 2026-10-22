// @vitest-environment jsdom
/**
 * ForgeStatsToolbarButton with issues bound to a provider other than the code
 * forge (#13700, #13745). The issues segment renders the issues provider's
 * stats dropdown, so whether it opens a popover — or routes to the provider's
 * issues page — follows that provider's slot, never the code forge's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { createRef, type ReactNode } from "react";
import { fireEvent } from "@testing-library/react";
import type { Issue, Page, PR } from "@shared/types/forge";
import type { ForgeStatsHandle } from "../ForgeStatsToolbarButton";
import { _resetForTests } from "@/lib/forgeResourceCache";

const mockListIssues = vi.fn<(cwd: string, opts?: unknown) => Promise<Page<Issue>>>();
const mockListPRs = vi.fn<(cwd: string, opts?: unknown) => Promise<Page<PR>>>();

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: {
    listIssues: (cwd: string, opts?: unknown) => mockListIssues(cwd, opts),
    listPRs: (cwd: string, opts?: unknown) => mockListPRs(cwd, opts),
    getRateLimitDetails: vi.fn().mockResolvedValue(null),
  },
}));

const refreshStatsMock = vi.fn().mockResolvedValue(undefined);
const mockIsTokenError = false;
const mockRateLimitResetAt: number | null = null;

vi.mock("@/hooks/useRepositoryStats", () => ({
  useRepositoryStats: () => ({
    stats: { issueCount: 3, prCount: 2, commitCount: 0 },
    loading: false,
    error: null,
    isTokenError: mockIsTokenError,
    refresh: refreshStatsMock,
    isStale: false,
    lastUpdated: Date.now(),
    rateLimitResetAt: mockRateLimitResetAt,
    rateLimitKind: null,
    freshnessLevel: "fresh" as const,
  }),
}));

vi.mock("@/hooks/useResolvedForgeProvider", () => {
  const code = {
    pluginId: "daintree.github",
    contribution: {
      id: "github",
      name: "GitHub",
      matches: ["github.com"],
      slots: { statsDropdown: "github.statsDropdown" },
    },
  };
  const issues = {
    pluginId: "daintree.linear",
    contribution: { id: "linear", name: "Linear", matches: [], roles: ["issues"], slots: {} },
  };
  return {
    useResolvedForgeProvider: () => ({
      entry: code,
      providerId: "daintree.github.github",
      resolvedVia: "hostname",
      issues: { entry: issues, providerId: "daintree.linear.linear", resolvedVia: "override" },
      loading: false,
      refresh: () => {},
    }),
  };
});

// Only the code forge contributes a stats dropdown; the issues provider has none.
vi.mock("@/registry/builtinRendererRegistry", () => ({
  useBuiltinView: (slotId: string) => (slotId === "github.statsDropdown" ? () => null : null),
}));

vi.mock("@/hooks/useGlobalMinuteTicker", () => ({
  useGlobalMinuteTicker: () => 0,
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (sel: (s: { activeWorktreeId: string | null }) => unknown) =>
    sel({ activeWorktreeId: null }),
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (sel: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    sel({ worktrees: new Map() }),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/fixed-dropdown", () => ({
  FixedDropdown: () => null,
}));

vi.mock("../ForgeStatusIndicator", () => ({
  ForgeStatusIndicator: () => null,
}));

import { ForgeStatsToolbarButton } from "../ForgeStatsToolbarButton";
import { actionService } from "@/services/ActionService";
import type { Project } from "@shared/types";

const PROJECT: Project = {
  id: "test-proj",
  path: "/test/proj",
  name: "proj",
  emoji: "🌲",
  lastOpened: 0,
};

function issuesButton(container: HTMLElement): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>('button[aria-label*="open issues"]');
  if (!btn) throw new Error("Issues button not found");
  return btn;
}

function prsButton(container: HTMLElement): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>(
    'button[aria-label*="open pull requests"]'
  );
  if (!btn) throw new Error("PRs button not found");
  return btn;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  _resetForTests();
  mockListIssues.mockReset();
  mockListPRs.mockReset();
  mockListIssues.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
  mockListPRs.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
  vi.mocked(actionService.dispatch).mockClear();
});

afterEach(() => {
  cleanup();
});

describe("ForgeStatsToolbarButton — slotless issues provider", () => {
  it("routes an issues click to the issues provider's page instead of an empty popover", () => {
    const { container } = render(<ForgeStatsToolbarButton currentProject={PROJECT} />);
    fireEvent.click(issuesButton(container));
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "forge.openIssues",
      { projectPath: PROJECT.path },
      { source: "user" }
    );
  });

  it("routes the imperative openIssues the same way", () => {
    const ref = createRef<ForgeStatsHandle>();
    render(<ForgeStatsToolbarButton ref={ref} currentProject={PROJECT} />);
    act(() => ref.current?.openIssues());
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "forge.openIssues",
      { projectPath: PROJECT.path },
      { source: "user" }
    );
  });

  it("doesn't warm an issue list nothing will show", async () => {
    const { container } = render(<ForgeStatsToolbarButton currentProject={PROJECT} />);
    fireEvent.pointerEnter(issuesButton(container), { pointerType: "mouse" });
    await settle();
    expect(mockListIssues).not.toHaveBeenCalled();
  });

  it("keeps the code forge's PR dropdown and its prefetch", async () => {
    const { container } = render(<ForgeStatsToolbarButton currentProject={PROJECT} />);
    fireEvent.pointerEnter(prsButton(container), { pointerType: "mouse" });
    await settle();
    expect(mockListPRs).toHaveBeenCalledTimes(1);
    fireEvent.click(prsButton(container));
    expect(actionService.dispatch).not.toHaveBeenCalledWith(
      "forge.openPRs",
      expect.anything(),
      expect.anything()
    );
  });
});
