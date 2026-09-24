// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import React from "react";

type RenderItem = (
  item: unknown,
  index: number,
  selected: boolean,
  onHoverIndex: (index: number) => void
) => React.ReactNode;

let capturedProps: {
  isFiltering?: boolean;
  onConfirm: () => void;
  onQueryChange: (q: string) => void;
  onSelectNext: () => void;
  query: string;
  results: CommandManifestEntry[];
  selectedIndex: number;
  getActionLabel?: (item: CommandManifestEntry) => string | null;
  renderItem?: RenderItem;
} | null = null;

vi.mock("@/components/ui/SearchablePalette", () => ({
  SearchablePalette: vi.fn((props: NonNullable<typeof capturedProps>) => {
    capturedProps = {
      isFiltering: props.isFiltering,
      onConfirm: props.onConfirm,
      onQueryChange: props.onQueryChange,
      onSelectNext: props.onSelectNext,
      query: props.query,
      results: props.results,
      selectedIndex: props.selectedIndex,
      getActionLabel: props.getActionLabel,
      renderItem: props.renderItem,
    };
    return null;
  }),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

const { useDeferredValueSpy } = vi.hoisted(() => {
  let override: string | null = null;
  return {
    useDeferredValueSpy: {
      setOverride: (v: string | null) => {
        override = v;
      },
      getOverride: () => override,
      impl: vi.fn((value: string) => {
        return override !== null ? override : value;
      }),
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useDeferredValue: useDeferredValueSpy.impl,
  };
});

import { CommandPicker, getCommandActionLabel, matchRanges, scoreCommand } from "../CommandPicker";
import type { CommandManifestEntry } from "@shared/types/commands";

function makeCmd(overrides: Partial<CommandManifestEntry> = {}): CommandManifestEntry {
  return {
    id: "test-cmd",
    label: "Test Command",
    description: "A test command",
    category: "system",
    enabled: true,
    keywords: [],
    hasBuilder: false,
    requiresArgs: false,
    kind: "command",
    ...overrides,
  } as CommandManifestEntry;
}

const commands: CommandManifestEntry[] = [
  makeCmd({ id: "git.commit", label: "Git Commit", category: "git", keywords: ["commit"] }),
  makeCmd({ id: "gh.pr", label: "GitHub PR", category: "github", keywords: ["pull"] }),
  makeCmd({ id: "sys.restart", label: "Restart", category: "system" }),
];

/** The option row renderItem draws for an item, past any band label above it. */
function rowOf(item: CommandManifestEntry, index: number) {
  const element = capturedProps!.renderItem!(item, index, true, vi.fn()) as React.ReactElement<{
    children: React.ReactNode;
  }>;
  return React.Children.toArray(element.props.children).find(
    (c): c is React.ReactElement<{ onClick: () => void; "aria-describedby"?: string }> =>
      React.isValidElement(c) && (c.props as Record<string, unknown>)["data-command-id"] === item.id
  )!;
}

function renderPicker(onSelect = vi.fn(), list: CommandManifestEntry[] = commands) {
  capturedProps = null;
  return render(
    React.createElement(CommandPicker, {
      isOpen: true,
      commands: list,
      isLoading: false,
      onSelect,
      onDismiss: vi.fn(),
    })
  );
}

beforeEach(() => {
  useDeferredValueSpy.setOverride(null);
  capturedProps = null;
  vi.clearAllMocks();
});

describe("CommandPicker stale filtering", () => {
  it("passes isFiltering=false when deferred value is synced with query", () => {
    renderPicker();
    expect(capturedProps).not.toBeNull();
    expect(capturedProps!.isFiltering).toBe(false);
  });

  it("passes isFiltering=true when deferred value lags behind query", () => {
    useDeferredValueSpy.setOverride("__STALE__");
    renderPicker();

    act(() => {
      capturedProps!.onQueryChange("git");
    });

    expect(capturedProps!.isFiltering).toBe(true);
    expect(capturedProps!.query).toBe("git");
  });
});

describe("CommandPicker confirm guard", () => {
  it("does not call onSelect while stale", () => {
    const onSelect = vi.fn();
    useDeferredValueSpy.setOverride("__STALE__");
    renderPicker(onSelect);

    act(() => {
      capturedProps!.onQueryChange("git");
    });
    expect(capturedProps!.isFiltering).toBe(true);

    act(() => {
      capturedProps!.onConfirm();
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not call onSelect on row click while stale", () => {
    const onSelect = vi.fn();
    useDeferredValueSpy.setOverride("__STALE__");
    renderPicker(onSelect);

    act(() => {
      capturedProps!.onQueryChange("git");
    });
    expect(capturedProps!.isFiltering).toBe(true);

    // Simulate clicking a row — renderItem produces the button element
    act(() => {
      rowOf(commands[0]!, 0).props.onClick();
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("calls onSelect on row click when not stale", () => {
    const onSelect = vi.fn();
    renderPicker(onSelect);

    // Not stale — useDeferredValue passthrough
    act(() => {
      rowOf(commands[0]!, 0).props.onClick();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("calls onSelect when not stale and results are available", () => {
    const onSelect = vi.fn();
    renderPicker(onSelect);

    // No override → useDeferredValue returns the same value as query
    // query="" deferred="" → isStale=false
    // All commands shown, ordered by category: github → git → system
    // flatCommands: [gh.pr, git.commit, sys.restart]
    // selectedIndex=0 → gh.pr

    act(() => {
      capturedProps!.onConfirm();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "gh.pr" }));
  });
});

describe("CommandPicker unavailable commands", () => {
  const list = [
    makeCmd({ id: "gh.off", category: "github", enabled: false, disabledReason: "No forge" }),
    makeCmd({ id: "gh.on", category: "github" }),
    makeCmd({ id: "git.off", category: "git", enabled: false, disabledReason: "Off here" }),
  ];

  it("starts the highlight on the first command Enter can run", () => {
    renderPicker(vi.fn(), list);
    const selected = capturedProps!.results[capturedProps!.selectedIndex]!;
    expect(selected.enabled).toBe(true);
  });

  it("keeps unavailable rows in the arrow-key path", () => {
    renderPicker(vi.fn(), list);
    const visited = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      act(() => capturedProps!.onSelectNext());
      visited.add(capturedProps!.results[capturedProps!.selectedIndex]!.id);
    }
    expect(visited.size).toBe(list.length);
  });

  it("does not act on an unavailable row from Enter or a click", () => {
    const onSelect = vi.fn();
    renderPicker(onSelect, list);
    const offIndex = capturedProps!.results.findIndex((c) => !c.enabled);
    for (let i = 0; i < list.length && capturedProps!.selectedIndex !== offIndex; i++) {
      act(() => capturedProps!.onSelectNext());
    }
    expect(capturedProps!.selectedIndex).toBe(offIndex);
    act(() => capturedProps!.onConfirm());
    act(() => rowOf(capturedProps!.results[offIndex]!, offIndex).props.onClick());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("promises a form only on rows that can open one", () => {
    const withBuilder = list.map((c) => ({ ...c, hasBuilder: true }));
    renderPicker(vi.fn(), withBuilder);
    for (const [index, cmd] of capturedProps!.results.entries()) {
      const row = rowOf(cmd, index) as React.ReactElement<Record<string, unknown>>;
      expect(row.props["aria-haspopup"] === "dialog").toBe(cmd.enabled);
    }
  });

  it("associates the reason with its row", () => {
    renderPicker(vi.fn(), list);
    for (const [index, cmd] of capturedProps!.results.entries()) {
      const describedBy = rowOf(cmd, index).props["aria-describedby"] ?? "";
      const reasonIds = describedBy.split(" ").filter((id) => id.endsWith("-reason"));
      expect(reasonIds.length).toBe(cmd.enabled ? 0 : 1);
    }
  });
});

describe("getCommandActionLabel", () => {
  it("offers no Enter hint for an unavailable command", () => {
    expect(getCommandActionLabel(makeCmd({ enabled: false }))).toBeNull();
  });

  it("tells a form-first command apart from one that runs at once", () => {
    const form = getCommandActionLabel(makeCmd({ hasBuilder: true }));
    const run = getCommandActionLabel(makeCmd({ hasBuilder: false }));
    expect(form).toBeTruthy();
    expect(run).toBeTruthy();
    expect(form).not.toBe(run);
  });
});

describe("CommandPicker search", () => {
  const createIssue = makeCmd({
    id: "github:create-issue",
    category: "github",
    description:
      "Create a GitHub issue in the current repository. Use structured sections, file links, and task lists to make issues self-contained for autonomous work.",
    keywords: ["issue", "create", "bug"],
  });
  const workIssue = makeCmd({
    id: "github:work-issue",
    category: "github",
    description:
      "Start working on a GitHub issue by creating an isolated worktree. Fetches issue details.",
    keywords: ["worktree", "branch"],
  });
  const sync = makeCmd({
    id: "git:sync-branch",
    category: "git",
    description: "Rebase the current branch onto its upstream and push the result.",
  });

  it("drops a command whose only match is letters scattered through its description", () => {
    // "worktree" is a subsequence of create-issue's description but no word in it.
    expect(scoreCommand(createIssue, "worktree")).toBeNull();
    expect(scoreCommand(workIssue, "worktree")).not.toBeNull();
    expect(scoreCommand(sync, "issue")).toBeNull();
  });

  it("ranks a match in the command name above one in the description", () => {
    const inName = scoreCommand(workIssue, "work")!;
    const inDescription = scoreCommand(sync, "upstream")!;
    expect(inName).toBeGreaterThan(inDescription);
  });

  it("finds a command typed the way its row prints it", () => {
    const bare = scoreCommand(workIssue, "github:work-issue");
    expect(bare).not.toBeNull();
    expect(scoreCommand(workIssue, "/github:work-issue")).toBe(bare);
  });

  it("treats a bare slash as browsing, not a search", () => {
    renderPicker(vi.fn(), [createIssue, sync, workIssue]);
    const browsing = capturedProps!.results.map((c) => c.id);
    act(() => capturedProps!.onQueryChange("/"));
    expect(capturedProps!.results.map((c) => c.id)).toEqual(browsing);
  });

  it("puts the best match first under Enter", () => {
    renderPicker(vi.fn(), [createIssue, sync, workIssue]);
    act(() => capturedProps!.onQueryChange("work"));
    expect(capturedProps!.results[0]!.id).toBe("github:work-issue");
    expect(capturedProps!.results[capturedProps!.selectedIndex]!.id).toBe("github:work-issue");
  });
});

describe("matchRanges", () => {
  const covered = (text: string, ranges: readonly (readonly [number, number])[]) =>
    ranges.map(([a, b]) => text.slice(a, b + 1).toLowerCase()).join("");

  it("marks exactly the characters the term matched", () => {
    const text = "Start working on a GitHub issue by creating an isolated worktree";
    for (const term of ["worktree", "git", "isolated"]) {
      expect(covered(text, matchRanges(text, term, false))).toBe(term);
    }
  });

  it("prefers the start of a word over the middle of one", () => {
    const [range] = matchRanges("reissue an issue", "issue", false);
    expect(range![0]).toBe("reissue an ".length);
  });

  it("marks scattered letters only where scattered matching applies", () => {
    expect(covered("github:work-issue", matchRanges("github:work-issue", "gwi", true))).toBe("gwi");
    expect(matchRanges("Create a GitHub issue", "cgi", false)).toEqual([]);
  });

  it("ignores the slash a query copies from the row", () => {
    expect(matchRanges("github:work-issue", "/github", true)).toEqual(
      matchRanges("github:work-issue", "github", true)
    );
  });
});
