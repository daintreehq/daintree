// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginConfirmDialog } from "../PluginConfirmDialog";
import {
  __resetPluginConfirmStoreForTesting,
  usePluginConfirmStore,
  type PendingPluginConfirm,
} from "@/store/pluginConfirmStore";

vi.mock("zustand/react/shallow", () => ({ useShallow: (fn: unknown) => fn }));
vi.mock("@/store", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

function pending(overrides: Partial<PendingPluginConfirm> = {}): PendingPluginConfirm {
  return {
    requestId: "r1",
    pluginId: "acme.tool",
    actionId: "acme.tool.doThing",
    actionTitle: "Do thing",
    actionDescription: "Does a thing",
    effectiveDanger: "confirm",
    argsSummary: "",
    enqueuedAt: 0,
    ...overrides,
  };
}

function enqueue(item: PendingPluginConfirm): void {
  act(() => usePluginConfirmStore.getState().enqueue(item));
}

/** The Arguments section, or null when the dialog omitted it entirely. */
function argsSection(): HTMLElement | null {
  return screen.queryByText("Arguments");
}

afterEach(() => {
  cleanup();
  __resetPluginConfirmStoreForTesting();
});

describe("PluginConfirmDialog arguments preview", () => {
  it("omits the Arguments section for an action with no arguments", () => {
    // The bug this replaces rendered the literal word "null" here, because
    // `summarizeMcpArgs(undefined)` serialized to the string "null" and the
    // `|| "(none)"` fallback never fired against a truthy value (#11299).
    render(<PluginConfirmDialog />);
    enqueue(pending({ argsSummary: "" }));

    expect(argsSection()).toBeNull();
    expect(screen.queryByText("null")).toBeNull();
    expect(screen.queryByText("(none)")).toBeNull();
  });

  it("renders the Arguments section with the summary when the action has arguments", () => {
    render(<PluginConfirmDialog />);
    enqueue(pending({ argsSummary: '{"path":"/tmp/x"}' }));

    expect(argsSection()).not.toBeNull();
    expect(screen.getByText('{"path":"/tmp/x"}')).toBeTruthy();
  });

  it("still shows the section for an argument that is genuinely null", () => {
    // "no arguments" and "one argument whose value is null" are different
    // facts; only the former is hidden. Suppressing both would hide a real
    // argument from the person being asked to approve the call.
    render(<PluginConfirmDialog />);
    enqueue(pending({ argsSummary: "null" }));

    expect(argsSection()).not.toBeNull();
    expect(screen.getByText("null")).toBeTruthy();
  });

  it("names the action in the title regardless of whether arguments render", () => {
    // Dropping the section must not leave the dialog without a subject.
    render(<PluginConfirmDialog />);
    enqueue(pending({ argsSummary: "", actionTitle: "Open tools panel" }));

    expect(screen.getByText("Run 'Open tools panel'?")).toBeTruthy();
  });
});
