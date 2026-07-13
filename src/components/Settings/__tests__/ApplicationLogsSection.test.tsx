// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ApplicationLogsSection } from "../TroubleshootingTab";

type NotifyPayload = {
  type: string;
  title: string;
  actions?: { label: string; onClick: () => void }[];
};

const mockDispatch = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
  ok: true,
  result: undefined,
});
const mockNotify = vi.fn<(payload: NotifyPayload) => void>();

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => mockDispatch(...args),
  },
}));

vi.mock("@/lib/notify", () => ({
  notify: (payload: NotifyPayload) => mockNotify(payload),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

describe("ApplicationLogsSection — clear confirmation", () => {
  const clearDispatches = () => mockDispatch.mock.calls.filter((call) => call[0] === "logs.clear");

  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatch.mockResolvedValue({ ok: true, result: undefined });
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  it("opens a confirmation instead of clearing when Clear Logs is clicked", async () => {
    render(<ApplicationLogsSection />);

    fireEvent.click(screen.getByText("Clear Logs"));

    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(clearDispatches()).toHaveLength(0);
  });

  it("preserves the logs when the confirmation is cancelled", async () => {
    render(<ApplicationLogsSection />);

    fireEvent.click(screen.getByText("Clear Logs"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByText("Cancel"));

    expect(clearDispatches()).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("clears exactly once when confirmed, then closes", async () => {
    render(<ApplicationLogsSection />);

    fireEvent.click(screen.getByText("Clear Logs"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByText("Clear logs"));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(clearDispatches()).toEqual([["logs.clear", undefined, { source: "user" }]]);
  });

  it("surfaces a failed clear with a recovery action that re-confirms", async () => {
    mockDispatch.mockResolvedValue({ ok: false, error: { message: "buffer locked" } });
    render(<ApplicationLogsSection />);

    fireEvent.click(screen.getByText("Clear Logs"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByText("Clear logs"));

    await waitFor(() => expect(mockNotify).toHaveBeenCalledTimes(1));
    const payload = mockNotify.mock.calls[0][0];
    expect(payload.type).toBe("error");

    // Recovery must reopen the confirmation, not re-dispatch the destructive action.
    const dispatchesBefore = clearDispatches().length;
    act(() => payload.actions?.[0].onClick());
    expect(clearDispatches()).toHaveLength(dispatchesBefore);
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
  });

  it("does not use window.confirm", () => {
    const confirmSpy = vi.spyOn(window, "confirm");

    render(<ApplicationLogsSection />);
    fireEvent.click(screen.getByText("Clear Logs"));

    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
