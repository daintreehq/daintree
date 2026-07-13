// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventsActions, LogsActions } from "../DiagnosticsActions";

type NotifyPayload = {
  type: string;
  title: string;
  priority?: string;
  context?: { eventKind?: string };
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

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

const logsState = { autoScroll: false, setAutoScroll: vi.fn() };

vi.mock("@/store", () => ({
  // LogsActions reads through selectors; the other components in this file don't.
  useLogsStore: (selector?: (state: typeof logsState) => unknown) =>
    selector ? selector(logsState) : logsState,
  useErrorStore: () => ({ errors: [] }),
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/store/telemetryPreviewStore", () => ({
  useTelemetryPreviewStore: () => ({ active: false, events: [] }),
}));

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useOverlayState: () => {},
  };
});

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/icons", () => {
  const stub = () => null;
  return {
    DaintreeIcon: stub,
    NpmIcon: stub,
    YarnIcon: stub,
    PnpmIcon: stub,
    BunIcon: stub,
    PythonIcon: stub,
    ComposerIcon: stub,
    DockerIcon: stub,
    RustIcon: stub,
    GoIcon: stub,
    RubyIcon: stub,
    NodeIcon: stub,
    DenoIcon: stub,
    GradleIcon: stub,
    PhpIcon: stub,
    ViteIcon: stub,
    WebpackIcon: stub,
    KotlinIcon: stub,
    SwiftIcon: stub,
    TerraformIcon: stub,
    ElixirIcon: stub,
    SpinnerCircle: stub,
    HollowCircle: stub,
    InteractingCircle: stub,
    ExitedCircle: stub,
  };
});

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

describe("LogsActions — clear confirmation", () => {
  const clearDispatches = () => mockDispatch.mock.calls.filter((call) => call[0] === "logs.clear");

  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatch.mockResolvedValue({ ok: true, result: undefined });
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  it("opens a confirmation instead of clearing when Clear is clicked", async () => {
    render(<LogsActions />);

    fireEvent.click(screen.getByText("Clear"));

    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(clearDispatches()).toHaveLength(0);
  });

  it("preserves the logs when the confirmation is cancelled", async () => {
    render(<LogsActions />);

    fireEvent.click(screen.getByText("Clear"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByText("Cancel"));

    expect(clearDispatches()).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("clears exactly once when confirmed, then closes", async () => {
    render(<LogsActions />);

    fireEvent.click(screen.getByText("Clear"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByText("Clear logs"));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(clearDispatches()).toEqual([["logs.clear", undefined, { source: "user" }]]);
  });

  it("surfaces a failed clear with a recovery action that re-confirms", async () => {
    mockDispatch.mockResolvedValue({ ok: false, error: { message: "buffer locked" } });
    render(<LogsActions />);

    fireEvent.click(screen.getByText("Clear"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByText("Clear logs"));

    await waitFor(() => expect(mockNotify).toHaveBeenCalledTimes(1));
    const payload = mockNotify.mock.calls[0]?.[0];
    expect(payload?.type).toBe("error");
    // Must carry an explicit priority: its eventKind policy is passive, so an
    // unset priority resolves to "low" — inbox-only, and the inbox keeps only
    // actions with an actionId, silently dropping the onClick recovery below.
    expect(payload?.priority).toBeDefined();
    expect(payload?.priority).not.toBe("low");

    // Recovery must reopen the confirmation, not re-dispatch the destructive action.
    const retry = payload?.actions?.[0];
    expect(retry).toBeDefined();
    const dispatchesBefore = clearDispatches().length;
    act(() => retry?.onClick());
    expect(clearDispatches()).toHaveLength(dispatchesBefore);
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
  });
});

describe("EventsActions — ConfirmDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  it("opens ConfirmDialog when Clear button is clicked", async () => {
    render(<EventsActions />);

    fireEvent.click(screen.getByText("Clear"));

    expect(screen.getByText("Clear events?")).toBeTruthy();
    expect(
      screen.getByText("All captured event records will be permanently deleted.")
    ).toBeTruthy();
    expect(screen.getByText("Clear events")).toBeTruthy();
  });

  it("closes dialog without dispatching when Cancel is clicked", async () => {
    render(<EventsActions />);

    fireEvent.click(screen.getByText("Clear"));

    fireEvent.click(screen.getByText("Cancel"));

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(screen.queryByText("Clear events?")).toBeNull();
  });

  it("dispatches clear action and closes dialog on Confirm", async () => {
    render(<EventsActions />);

    fireEvent.click(screen.getByText("Clear"));

    fireEvent.click(screen.getByText("Clear events"));

    expect(mockDispatch).toHaveBeenCalledWith("eventInspector.clear", undefined, {
      source: "user",
    });
    // After dispatch resolves, dialog should close
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Clear events?")).toBeNull();
  });

  it("does not show dialog before clicking Clear", () => {
    render(<EventsActions />);

    expect(screen.queryByText("Clear events?")).toBeNull();
  });

  it("does not use window.confirm", () => {
    const confirmSpy = vi.spyOn(window, "confirm");

    render(<EventsActions />);

    fireEvent.click(screen.getByText("Clear"));

    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
