// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import { DecisionsInboxHost } from "../DecisionsInboxHost";

const loaded = vi.fn();
const dialogProps = vi.hoisted(() => [] as Array<{ navigateToTerminal?: unknown }>);
vi.mock("../DecisionsInboxDialog", () => {
  loaded();
  return {
    DecisionsInboxDialog: (props: { navigateToTerminal?: unknown }) => {
      dialogProps.push(props);
      return <div data-testid="inbox-dialog" />;
    },
  };
});

beforeEach(() => {
  dialogProps.length = 0;
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

  it("hands the inbox the window's own way to a terminal (#18048)", async () => {
    const navigateToTerminal = vi.fn();
    render(<DecisionsInboxHost navigateToTerminal={navigateToTerminal} />);
    act(() => useDecisionsInboxStore.getState().open());
    await screen.findByTestId("inbox-dialog");
    expect(dialogProps.at(-1)?.navigateToTerminal).toBe(navigateToTerminal);
  });
});
