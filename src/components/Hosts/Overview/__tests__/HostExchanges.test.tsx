// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantExchangeView, RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";

const h = vi.hoisted(() => ({
  list: vi.fn(),
  cancel: vi.fn(),
  listeners: new Set<(event: RemoteHostsEvent) => void>(),
}));

vi.mock("@/clients/remoteHostsClient", () => ({
  remoteHostsClient: {
    listAssistantExchanges: h.list,
    cancelAssistantExchange: h.cancel,
    onEvent: (listener: (event: RemoteHostsEvent) => void) => {
      h.listeners.add(listener);
      return () => h.listeners.delete(listener);
    },
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: (props: {
    isOpen: boolean;
    title: ReactNode;
    description?: ReactNode;
    confirmLabel: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onClose?: () => void;
    children?: ReactNode;
  }) =>
    props.isOpen ? (
      <div role="dialog">
        <h2>{props.title}</h2>
        <p>{props.description}</p>
        {props.children}
        <button type="button" onClick={props.onConfirm}>
          {`confirm: ${props.confirmLabel}`}
        </button>
        <button type="button" onClick={props.onClose}>
          {props.cancelLabel}
        </button>
      </div>
    ) : null,
}));

import { HostExchanges } from "../HostExchanges";

function view(overrides: Partial<AssistantExchangeView> = {}): AssistantExchangeView {
  return {
    hostId: "studio-01",
    messageId: "m-1",
    sentAt: 1_000,
    updatedAt: 2_000,
    state: "submitted",
    outcome: null,
    delivery: "pending",
    deliveryAt: null,
    sendingLane: "hub",
    hopCount: 1,
    receiver: { projectId: "p1", slot: 1 },
    contextId: "ctx-1234567890",
    cancelRequestedAt: null,
    terminalAt: null,
    expiresAt: null,
    cancel: "cancel",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function emit(event: RemoteHostsEvent) {
  for (const listener of [...h.listeners]) listener(event);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  h.list.mockReset();
  h.cancel.mockReset();
  h.listeners.clear();
});
afterEach(() => cleanup());

describe("HostExchanges", () => {
  it("shows nothing for a host this Shell never messaged", async () => {
    h.list.mockResolvedValue([]);
    render(<HostExchanges hostId="studio-01" hostName="studio-01" />);
    await flush();
    expect(screen.queryByTestId("host-exchanges")).toBeNull();
  });

  it("shows each exchange's observed state, delivery and provenance", async () => {
    h.list.mockResolvedValue([
      view({ messageId: "m-1", state: "working", delivery: "inbox-fetched", cancel: "request" }),
      view({
        messageId: "m-2",
        state: "failed",
        outcome: "expired",
        delivery: "unconfirmed",
        cancel: null,
      }),
      view({
        messageId: "m-3",
        state: null,
        delivery: "unconfirmed",
        receiver: null,
        contextId: null,
        cancel: null,
      }),
    ]);
    render(
      <HostExchanges
        hostId="studio-01"
        hostName="studio-01"
        projects={[{ id: "p1", name: "api", path: "/home/g/api" }]}
      />
    );
    await flush();
    const rows = screen.getAllByTestId("host-exchange-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("Working · Fetched by lane");
    expect(rows[0]!.textContent).toContain("Hub → Session 2 · api · 1 hop");
    expect(rows[0]!.textContent).toContain("conversation ctx-1234…");
    // Expiry is never shown as a failure, and an unanswered send never as anything but unknown.
    expect(rows[1]!.textContent).toContain("Expired · Couldn't confirm delivery");
    expect(rows[1]!.textContent).not.toContain("Failed");
    expect(rows[2]!.textContent).toContain("Couldn't confirm delivery");
    expect(rows[2]!.textContent).toContain("Lane not known yet");
    expect(screen.getAllByRole("button", { name: /Request cancel/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Cancel exchange/ })).toBeNull();
  });

  it("reads again when this host's exchanges change, keeping only the newest read", async () => {
    const first = deferred<AssistantExchangeView[]>();
    const second = deferred<AssistantExchangeView[]>();
    h.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<HostExchanges hostId="studio-01" hostName="studio-01" />);
    emit({ type: "exchanges-changed", hostId: "studio-02" });
    expect(h.list).toHaveBeenCalledTimes(1);
    emit({ type: "exchanges-changed", hostId: "studio-01" });
    expect(h.list).toHaveBeenCalledTimes(2);
    await act(async () => {
      second.resolve([view({ state: "completed", delivery: "reply-received", cancel: null })]);
      await second.promise;
    });
    await act(async () => {
      first.resolve([view()]);
      await first.promise;
    });
    expect(screen.getByTestId("host-exchange-row").textContent).toContain(
      "Completed · Reply received"
    );
  });

  it("confirms a cancel with what it would cancel, then shows what the host recorded", async () => {
    h.list.mockResolvedValueOnce([view()]);
    h.list.mockResolvedValueOnce([
      view({ state: "canceled", cancel: null, cancelRequestedAt: 3_000 }),
    ]);
    h.cancel.mockResolvedValue(view({ state: "canceled", cancel: null }));
    render(<HostExchanges hostId="studio-01" hostName="studio-01" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Cancel exchange/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Cancel the exchange with Session 2 · p1?");
    expect(dialog.textContent).toContain("ctx-1234567890");
    expect(dialog.textContent).toContain("m-1");
    expect(h.cancel).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByText("confirm: Cancel exchange"));
    });
    await flush();
    expect(h.cancel).toHaveBeenCalledWith("studio-01", "m-1");
    expect(screen.getByTestId("host-exchange-row").textContent).toContain("Canceled");
    expect(screen.queryByRole("button", { name: /Cancel exchange/ })).toBeNull();
  });

  it("labels a delivered exchange's cancel as a request the assistant may already have acted on", async () => {
    h.list.mockResolvedValue([view({ delivery: "wake-typed", cancel: "request" })]);
    render(<HostExchanges hostId="studio-01" hostName="studio-01" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Request cancel/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Request cancel of the exchange with Session 2 · p1?");
    expect(dialog.textContent).toContain("may have acted on it");
    fireEvent.click(screen.getByText("Keep exchange"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("shows a recorded request as such, with nothing to press", async () => {
    h.list.mockResolvedValue([view({ cancel: "requested", cancelRequestedAt: 3_000 })]);
    render(<HostExchanges hostId="studio-01" hostName="studio-01" />);
    await flush();
    expect(screen.getByText("Cancel requested")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });

  it("keeps a failed cancel inline and still shows the journal", async () => {
    h.list.mockResolvedValue([view()]);
    h.cancel.mockRejectedValue(new Error("link dropped"));
    render(<HostExchanges hostId="studio-01" hostName="studio-01" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Cancel exchange/ }));
    await act(async () => {
      fireEvent.click(screen.getByText("confirm: Cancel exchange"));
    });
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("link dropped");
    expect(screen.getByTestId("host-exchange-row")).toBeTruthy();
  });

  it("offers Retry when the journal couldn't be read", async () => {
    h.list.mockRejectedValueOnce(new Error("no database"));
    h.list.mockResolvedValueOnce([view()]);
    render(<HostExchanges hostId="studio-01" hostName="studio-01" />);
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("no database");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("host-exchange-row")).toBeTruthy();
  });

  it("stops listening once unmounted", async () => {
    h.list.mockResolvedValue([view()]);
    const { unmount } = render(<HostExchanges hostId="studio-01" hostName="studio-01" />);
    await flush();
    unmount();
    expect(h.listeners.size).toBe(0);
  });
  it("follows a live update while confirming: a delivery turns it into a request, an end closes it", async () => {
    h.list.mockResolvedValueOnce([view()]);
    render(<HostExchanges hostId="studio-01" hostName="studio-01" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Cancel exchange/ }));
    expect(screen.getByText("confirm: Cancel exchange")).toBeTruthy();

    h.list.mockResolvedValueOnce([view({ delivery: "wake-typed", cancel: "request" })]);
    await act(async () => {
      emit({ type: "exchanges-changed", hostId: "studio-01" });
    });
    await flush();
    expect(screen.getByText("confirm: Request cancel")).toBeTruthy();

    h.list.mockResolvedValueOnce([
      view({ state: "completed", delivery: "reply-received", cancel: null }),
    ]);
    await act(async () => {
      emit({ type: "exchanges-changed", hostId: "studio-01" });
    });
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reads again at the next expiry even when the host never announces it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      vi.setSystemTime(10_000);
      h.list.mockResolvedValueOnce([view({ expiresAt: 70_000 })]);
      h.list.mockResolvedValueOnce([
        view({ state: "failed", outcome: "expired", delivery: "unconfirmed", cancel: null }),
      ]);
      render(<HostExchanges hostId="studio-01" hostName="studio-01" />);
      await flush();
      expect(h.list).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(h.list).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      await flush();
      expect(h.list).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("host-exchange-row").textContent).toContain(
        "Expired · Couldn't confirm delivery"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells cancel buttons for the same lane apart by message", async () => {
    h.list.mockResolvedValue([
      view({ messageId: "msg-aaaaaaaa-1" }),
      view({ messageId: "msg-bbbbbbbb-2" }),
    ]);
    render(<HostExchanges hostId="studio-01" hostName="studio-01" />);
    await flush();
    const names = screen
      .getAllByRole("button", { name: /Cancel exchange/ })
      .map((button) => button.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(2);
  });
});
