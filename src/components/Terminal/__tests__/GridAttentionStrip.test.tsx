// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import type { TabGroup } from "@shared/types/panel";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock("lucide-react", () => ({
  ArrowRight: (props: { className?: string }) => <span data-testid="arrow-right" {...props} />,
}));

vi.mock("@/components/icons", () => ({
  HollowCircle: (props: { className?: string }) => <span data-testid="hollow-circle" {...props} />,
  InteractingCircle: (props: { className?: string }) => (
    <span data-testid="interacting-circle" {...props} />
  ),
}));

const panelState = {
  panelsById: {} as Record<string, unknown>,
};

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (s: typeof panelState) => unknown) => selector(panelState),
}));

const dispatchMock = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  },
}));

import { GridAttentionStrip } from "../GridAttentionStrip";

function makeGroup(panelIds: string[], activeTabId?: string): TabGroup {
  return {
    id: `g-${panelIds.join("-")}`,
    location: "grid",
    panelIds,
    activeTabId: activeTabId ?? panelIds[0] ?? "",
    worktreeId: null,
  } as unknown as TabGroup;
}

beforeEach(() => {
  panelState.panelsById = {};
  dispatchMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("GridAttentionStrip", () => {
  it("renders nothing when no agent needs attention", () => {
    panelState.panelsById = {
      a: { id: "a", agentState: "working", runtimeStatus: "ok" },
      b: { id: "b", agentState: "idle", runtimeStatus: "ok" },
    };
    const { container } = render(
      <GridAttentionStrip tabGroups={[makeGroup(["a"]), makeGroup(["b"])]} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders waiting, directing, and errored counts when present", () => {
    panelState.panelsById = {
      a: { id: "a", agentState: "waiting", runtimeStatus: "ok" },
      b: { id: "b", agentState: "directing", runtimeStatus: "ok" },
      c: { id: "c", agentState: "working", runtimeStatus: "error" },
    };
    render(
      <GridAttentionStrip tabGroups={[makeGroup(["a"]), makeGroup(["b"]), makeGroup(["c"])]} />
    );

    const region = screen.getByRole("status");
    expect(region).toBeTruthy();
    expect(region.textContent).toContain("1");
    expect(region.textContent).toContain("waiting");
    expect(region.textContent).toContain("directing");
    expect(region.textContent).toContain("errored");
  });

  it("counts only the active tab of each group", () => {
    // Group has two panels but only the active tab contributes to counts.
    panelState.panelsById = {
      a: { id: "a", agentState: "idle", runtimeStatus: "ok" },
      b: { id: "b", agentState: "waiting", runtimeStatus: "ok" },
    };
    const { container } = render(<GridAttentionStrip tabGroups={[makeGroup(["a", "b"], "a")]} />);
    expect(container.firstChild).toBeNull();
  });

  it("dispatches terminal.jumpToNextAttention when the button is clicked", () => {
    panelState.panelsById = {
      a: { id: "a", agentState: "waiting", runtimeStatus: "ok" },
    };
    render(<GridAttentionStrip tabGroups={[makeGroup(["a"])]} />);

    const button = screen.getByRole("button", { name: /jump to next/i });
    fireEvent.click(button);

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith("terminal.jumpToNextAttention", undefined, {
      source: "user",
    });
  });

  it("falls back to the first panel id when activeTabId is missing from the group's panelIds", () => {
    panelState.panelsById = {
      a: { id: "a", agentState: "waiting", runtimeStatus: "ok" },
    };
    // activeTabId points to a panel that's no longer in the group — use first.
    const group = makeGroup(["a"], "missing");
    render(<GridAttentionStrip tabGroups={[group]} />);

    expect(screen.getByRole("status").textContent).toContain("waiting");
  });

  it("skips empty groups and missing panels without throwing", () => {
    panelState.panelsById = {
      a: { id: "a", agentState: "waiting", runtimeStatus: "ok" },
    };
    const emptyGroup = makeGroup([]);
    const missingPanelGroup = makeGroup(["ghost"]);
    const realGroup = makeGroup(["a"]);
    render(<GridAttentionStrip tabGroups={[emptyGroup, missingPanelGroup, realGroup]} />);

    expect(screen.getByRole("status").textContent).toContain("waiting");
  });

  it("counts a panel in both directing and errored when both apply", () => {
    panelState.panelsById = {
      a: { id: "a", agentState: "directing", runtimeStatus: "error" },
    };
    render(<GridAttentionStrip tabGroups={[makeGroup(["a"])]} />);

    const region = screen.getByRole("status");
    expect(region.textContent).toContain("directing");
    expect(region.textContent).toContain("errored");
  });

  it("button uses focus-visible outline, not focus:ring", () => {
    panelState.panelsById = {
      a: { id: "a", agentState: "waiting", runtimeStatus: "ok" },
    };
    render(<GridAttentionStrip tabGroups={[makeGroup(["a"])]} />);

    const button = screen.getByRole("button", { name: /jump to next/i });
    expect(button.className).toContain("focus-visible:outline");
    expect(button.className).toContain("focus-visible:outline-daintree-accent");
    expect(button.className).not.toMatch(/(^|\s)focus:ring-/);
  });
});
