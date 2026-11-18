// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import { DecisionsInboxHost } from "../DecisionsInboxHost";

const loaded = vi.fn();
vi.mock("../DecisionsInboxDialog", () => {
  loaded();
  return { DecisionsInboxDialog: () => <div data-testid="inbox-dialog" /> };
});

beforeEach(() => {
  useDecisionsInboxStore.setState({ isOpen: false, request: { terminalId: null, seq: 0 } });
});

afterEach(() => {
  cleanup();
});

describe("DecisionsInboxHost (#17231)", () => {
  it("loads nothing until the inbox is first opened, then mounts it", async () => {
    render(<DecisionsInboxHost />);
    // Any import started on mount has had its chance to land.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByTestId("inbox-dialog")).toBeNull();
    expect(loaded).not.toHaveBeenCalled();

    act(() => useDecisionsInboxStore.getState().open());
    expect(await screen.findByTestId("inbox-dialog")).toBeTruthy();
    expect(loaded).toHaveBeenCalledOnce();
  });
});
