// @vitest-environment jsdom
/**
 * ForgeStatsToolbarButton while its forge provider resolves (#15931). The
 * control holds the slot at the loaded pill's width instead of drawing nothing,
 * so a git project's row doesn't move when the pill appears, and the slot's
 * no-drag rectangle is there from the first paint.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ForgeProviderEntry } from "@shared/types/forge";
import type { Project } from "@shared/types";

const providerState = vi.hoisted(
  (): { loading: boolean; entry: ForgeProviderEntry | null } => ({ loading: true, entry: null })
);

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: {
    listIssues: vi.fn(),
    listPRs: vi.fn(),
    getRateLimitDetails: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/hooks/useRepositoryStats", () => ({
  useRepositoryStats: () => ({
    stats: { issueCount: 3, prCount: 2, commitCount: 5 },
    loading: false,
    error: null,
    isTokenError: false,
    refresh: vi.fn(),
    isStale: false,
    lastUpdated: Date.now(),
    rateLimitResetAt: null,
    rateLimitKind: null,
    freshnessLevel: "fresh" as const,
  }),
}));

vi.mock("@/hooks/useResolvedForgeProvider", () => ({
  useResolvedForgeProvider: () => ({
    entry: providerState.entry,
    providerId: providerState.entry ? "daintree.github.github" : null,
    resolvedVia: providerState.entry ? "hostname" : null,
    issues: {
      entry: providerState.entry,
      providerId: providerState.entry ? "daintree.github.github" : null,
      resolvedVia: providerState.entry ? "code" : null,
    },
    loading: providerState.loading,
    refresh: () => {},
  }),
}));

vi.mock("@/registry/builtinRendererRegistry", () => ({
  useBuiltinView: () => null,
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

const PROJECT: Project = {
  id: "test-proj",
  path: "/test/proj",
  name: "proj",
  emoji: "🌲",
  lastOpened: 0,
};

const GITHUB: ForgeProviderEntry = {
  pluginId: "daintree.github",
  contribution: { id: "github", name: "GitHub", matches: ["github.com"] },
};

/** The control's width in rem, from the held slot's class or the pill's inline calc. */
function controlWidthRem(container: HTMLElement): number {
  const control = container.querySelector<HTMLElement>(".toolbar-stats");
  if (!control) throw new Error("No stats control rendered");
  // The pill's calc adds a rem and a px term per trailing indicator; none shows here.
  const inline = [...control.style.width.matchAll(/([\d.]+)rem/g)];
  if (inline.length > 0) return inline.reduce((sum, [, rem]) => sum + Number(rem), 0);
  const held = /(?:^|\s)w-\[([\d.]+)rem\](?:\s|$)/.exec(control.className)?.[1];
  if (held === undefined) throw new Error("No width on the stats control");
  return Number(held);
}

function renderButton() {
  const view = render(<ForgeStatsToolbarButton currentProject={PROJECT} />);
  return {
    container: view.container,
    // The mocked provider hook holds no state of its own, so a fresh project row
    // stands in for the re-render its answer causes past the button's memo.
    rerender: () => view.rerender(<ForgeStatsToolbarButton currentProject={{ ...PROJECT }} />),
  };
}

afterEach(() => {
  cleanup();
  providerState.loading = true;
  providerState.entry = null;
});

describe("ForgeStatsToolbarButton while the forge provider resolves (#15931)", () => {
  it("holds an inert slot instead of drawing nothing", () => {
    const { container } = renderButton();

    const held = container.querySelector<HTMLElement>(".toolbar-stats");
    expect(held).not.toBeNull();
    expect(held?.classList.contains("app-no-drag")).toBe(true);
    expect(held?.classList.contains("pointer-events-none")).toBe(true);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("holds exactly the width a forge provider's pill then takes, so the row doesn't move", () => {
    const { container, rerender } = renderButton();
    const heldWidth = controlWidthRem(container);

    providerState.loading = false;
    providerState.entry = GITHUB;
    rerender();

    expect(container.querySelectorAll("button").length).toBeGreaterThan(0);
    expect(controlWidthRem(container)).toBe(heldWidth);
  });

  it("only ever shrinks into the commits-only pill when no provider answers", () => {
    const { container, rerender } = renderButton();
    const heldWidth = controlWidthRem(container);

    providerState.loading = false;
    rerender();

    expect(container.querySelectorAll("button").length).toBeGreaterThan(0);
    expect(controlWidthRem(container)).toBeLessThan(heldWidth);
  });
});
