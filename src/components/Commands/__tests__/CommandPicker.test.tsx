// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import React from "react";

let capturedProps: {
  isFiltering?: boolean;
  onConfirm: () => void;
  onQueryChange: (q: string) => void;
  query: string;
  renderItem?: (item: unknown, index: number, selected: boolean) => React.ReactNode;
} | null = null;

vi.mock("@/components/ui/SearchablePalette", () => ({
  SearchablePalette: vi.fn(
    (props: {
      isFiltering?: boolean;
      onConfirm: () => void;
      onQueryChange: (q: string) => void;
      query: string;
      renderItem?: (item: unknown, index: number, selected: boolean) => React.ReactNode;
    }) => {
      capturedProps = {
        isFiltering: props.isFiltering,
        onConfirm: props.onConfirm,
        onQueryChange: props.onQueryChange,
        query: props.query,
        renderItem: props.renderItem,
      };
      return null;
    }
  ),
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

import { CommandPicker } from "../CommandPicker";
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

function renderPicker(onSelect = vi.fn()) {
  capturedProps = null;
  return render(
    React.createElement(CommandPicker, {
      isOpen: true,
      commands,
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
    const element = capturedProps!.renderItem!(commands[0], 0, true) as React.ReactElement<{
      children: React.ReactNode;
    }>;
    const children = React.Children.toArray(element.props.children);
    const button = children.find(
      (c): c is React.ReactElement<{ onClick: () => void }> =>
        React.isValidElement(c) && c.type === "button"
    )!;
    act(() => {
      button.props.onClick();
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("calls onSelect on row click when not stale", () => {
    const onSelect = vi.fn();
    renderPicker(onSelect);

    // Not stale — useDeferredValue passthrough
    const element = capturedProps!.renderItem!(commands[0], 0, true) as React.ReactElement<{
      children: React.ReactNode;
    }>;
    const children = React.Children.toArray(element.props.children);
    const button = children.find(
      (c): c is React.ReactElement<{ onClick: () => void }> =>
        React.isValidElement(c) && c.type === "button"
    )!;
    act(() => {
      button.props.onClick();
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
