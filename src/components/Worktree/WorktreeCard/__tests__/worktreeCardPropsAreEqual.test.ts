import { describe, it, expect, vi } from "vitest";
import type { WorktreeCardProps } from "../../WorktreeCard";

vi.mock("zustand/react/shallow", () => ({ useShallow: (fn: unknown) => fn }));
vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    errorsClient: { retry: vi.fn() },
    worktreeClient: {
      attachIssue: vi.fn(),
      detachIssue: vi.fn(),
      getAll: vi.fn().mockResolvedValue([]),
      refresh: vi.fn(),
      getAllIssueAssociations: vi.fn().mockResolvedValue({}),
      onUpdate: vi.fn(() => () => {}),
      onRemove: vi.fn(() => () => {}),
      onActivated: vi.fn(() => () => {}),
    },
  };
});
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

const { worktreeCardPropsAreEqual } = await import("../../WorktreeCard");

const noop = () => {};

const baseWorktree = {
  id: "wt-a",
  worktreeId: "wt-a",
  path: "/tmp/wt-a",
  name: "wt-a",
  branch: "feature/a",
  isCurrent: false,
  isMainWorktree: false,
  worktreeChanges: null,
  lastActivityTimestamp: null,
};

function baseProps(overrides: Partial<WorktreeCardProps> = {}): WorktreeCardProps {
  return {
    worktree: baseWorktree,
    isActive: false,
    isFocused: false,
    onSelect: noop,
    onCopyTree: noop,
    onOpenEditor: noop,
    ...overrides,
  };
}

describe("worktreeCardPropsAreEqual", () => {
  it("returns true when all props are identical", () => {
    const p = baseProps();
    expect(worktreeCardPropsAreEqual(p, p)).toBe(true);
  });

  it("returns true when worktree object is same reference", () => {
    const wt = { ...baseWorktree };
    expect(
      worktreeCardPropsAreEqual(baseProps({ worktree: wt }), baseProps({ worktree: wt }))
    ).toBe(true);
  });

  it("returns true when worktree is a new reference with identical fields", () => {
    const prev = baseProps({ worktree: { ...baseWorktree } });
    const next = baseProps({ worktree: { ...baseWorktree } });
    expect(worktreeCardPropsAreEqual(prev, next)).toBe(true);
  });

  it("returns false when worktree branch changes", () => {
    const prev = baseProps({ worktree: { ...baseWorktree, branch: "feature/a" } });
    const next = baseProps({ worktree: { ...baseWorktree, branch: "feature/b" } });
    expect(worktreeCardPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when worktree modifiedCount changes", () => {
    const prev = baseProps({ worktree: { ...baseWorktree, modifiedCount: 0 } });
    const next = baseProps({ worktree: { ...baseWorktree, modifiedCount: 3 } });
    expect(worktreeCardPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when worktreeChanges reference changes", () => {
    const changes = { worktreeId: "wt-a", rootPath: "/tmp/wt-a", changes: [], changedFileCount: 2 };
    const prev = baseProps({ worktree: { ...baseWorktree, worktreeChanges: changes } });
    const next = baseProps({
      worktree: { ...baseWorktree, worktreeChanges: { ...changes } },
    });
    expect(worktreeCardPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns true when worktreeChanges is same reference", () => {
    const changes = { worktreeId: "wt-a", rootPath: "/tmp/wt-a", changes: [], changedFileCount: 2 };
    const prev = baseProps({ worktree: { ...baseWorktree, worktreeChanges: changes } });
    const next = baseProps({ worktree: { ...baseWorktree, worktreeChanges: changes } });
    expect(worktreeCardPropsAreEqual(prev, next)).toBe(true);
  });

  it("returns false when isActive changes", () => {
    expect(
      worktreeCardPropsAreEqual(baseProps({ isActive: false }), baseProps({ isActive: true }))
    ).toBe(false);
  });

  it("returns false when isFocused changes", () => {
    expect(
      worktreeCardPropsAreEqual(baseProps({ isFocused: false }), baseProps({ isFocused: true }))
    ).toBe(false);
  });

  it("returns false when onSelect callback changes reference", () => {
    expect(
      worktreeCardPropsAreEqual(
        baseProps({ onSelect: () => {} }),
        baseProps({ onSelect: () => {} })
      )
    ).toBe(false);
  });

  it("returns true when onSelect callback is same reference", () => {
    const onSelect = vi.fn();
    expect(worktreeCardPropsAreEqual(baseProps({ onSelect }), baseProps({ onSelect }))).toBe(true);
  });

  it("returns false when agentAvailability values change", () => {
    const prev = baseProps({ agentAvailability: { claude: true, codex: false } as never });
    const next = baseProps({ agentAvailability: { claude: true, codex: true } as never });
    expect(worktreeCardPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns true when agentAvailability has same values (different reference)", () => {
    const prev = baseProps({ agentAvailability: { claude: true } as never });
    const next = baseProps({ agentAvailability: { claude: true } as never });
    expect(worktreeCardPropsAreEqual(prev, next)).toBe(true);
  });

  it("returns false when agentAvailability key count changes", () => {
    const prev = baseProps({ agentAvailability: { claude: true } as never });
    const next = baseProps({ agentAvailability: { claude: true, codex: false } as never });
    expect(worktreeCardPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns true when both agentAvailability are undefined", () => {
    const prev = baseProps({ agentAvailability: undefined });
    const next = baseProps({ agentAvailability: undefined });
    expect(worktreeCardPropsAreEqual(prev, next)).toBe(true);
  });

  it("returns false when worktree prNumber changes", () => {
    const prev = baseProps({ worktree: { ...baseWorktree, prNumber: undefined } });
    const next = baseProps({ worktree: { ...baseWorktree, prNumber: 42 } });
    expect(worktreeCardPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when worktree issueTitle changes", () => {
    const prev = baseProps({ worktree: { ...baseWorktree, issueTitle: "Old title" } });
    const next = baseProps({ worktree: { ...baseWorktree, issueTitle: "New title" } });
    expect(worktreeCardPropsAreEqual(prev, next)).toBe(false);
  });

  it("returns false when variant changes", () => {
    expect(
      worktreeCardPropsAreEqual(baseProps({ variant: "sidebar" }), baseProps({ variant: "grid" }))
    ).toBe(false);
  });

  it("returns false when isDraggingSort changes", () => {
    expect(
      worktreeCardPropsAreEqual(
        baseProps({ isDraggingSort: false }),
        baseProps({ isDraggingSort: true })
      )
    ).toBe(false);
  });
});
