// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";
import { DecisionsAttentionHost } from "../DecisionsAttentionHost";

const loaded = vi.hoisted(() => ({ count: 0 }));

vi.mock("../DecisionsAttentionDialog", () => {
  loaded.count += 1;
  return {
    DecisionsAttentionDialog: ({ isOpen }: { isOpen: boolean }) => (
      <div data-testid="attention-dialog" data-open={String(isOpen)} />
    ),
  };
});

beforeEach(() => {
  useDecisionsAttentionStore.setState({
    isOpen: false,
    request: { terminalId: null, returnFocusTo: null, seq: 0 },
  });
});

afterEach(() => {
  cleanup();
});

describe("DecisionsAttentionHost", () => {
  it("loads nothing until the list is first opened, then shows it", async () => {
    render(<DecisionsAttentionHost />);
    expect(loaded.count).toBe(0);
    expect(screen.queryByTestId("attention-dialog")).toBeNull();

    await act(async () => {
      useDecisionsAttentionStore.getState().open("term-1");
    });

    const dialog = await screen.findByTestId("attention-dialog");
    expect(loaded.count).toBe(1);
    expect(dialog.getAttribute("data-open")).toBe("true");
  });
});
