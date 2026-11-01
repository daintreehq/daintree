// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  DecisionsExportResult,
  DecisionsLocalDeleteResult,
  DecisionsRelayDeleteResult,
  DecisionsStatus,
  DeleteDecisionsRelayDataPayload,
  ExportDecisionsDataPayload,
} from "@shared/types/decisions";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DecisionsDataSection } from "../DecisionsDataSection";

const ORIGIN = "https://decisions.example.workers.dev";
const HOST = "decisions.example.workers.dev";
const PASSPHRASE = "a long export passphrase";

const exportData = vi.fn<(payload: ExportDecisionsDataPayload) => Promise<DecisionsExportResult>>();
const deleteRelayData =
  vi.fn<(payload: DeleteDecisionsRelayDataPayload) => Promise<DecisionsRelayDeleteResult>>();
const deleteLocalData = vi.fn<() => Promise<DecisionsLocalDeleteResult>>();

function renderSection(
  status: DecisionsStatus,
  options: { locked?: boolean; onChanged?: (status: DecisionsStatus | null) => void } = {}
) {
  return render(
    <TooltipProvider>
      <DecisionsDataSection status={status} locked={options.locked} onChanged={options.onChanged} />
    </TooltipProvider>
  );
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

/** ConfirmDialog marks an unavailable primary with aria-disabled, keeping it focusable. */
function unavailable(element: HTMLElement): boolean {
  return element.getAttribute("aria-disabled") === "true";
}

/** A dialog plays its exit before it leaves the DOM. */
async function gone(role: "dialog" | "alertdialog") {
  await vi.waitFor(() => expect(screen.queryByRole(role)).toBeNull());
}

function passphraseFields(): [HTMLInputElement, HTMLInputElement] {
  const scope = within(screen.getByRole("dialog"));
  return [
    scope.getByLabelText("Passphrase") as HTMLInputElement,
    scope.getByLabelText("Passphrase again") as HTMLInputElement,
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

describe("DecisionsDataSection", () => {
  beforeEach(() => {
    exportData.mockReset();
    deleteRelayData.mockReset();
    deleteLocalData.mockReset();
    Object.defineProperty(window, "electron", {
      value: { decisions: { exportData, deleteRelayData, deleteLocalData } },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("exports only with the same long-enough passphrase twice, clearing both once sent", async () => {
    exportData.mockResolvedValue({
      result: "saved",
      path: "/Users/someone/Exports/decisions-export-2026-11-01.dxz.json",
      questions: 3,
      auditEvents: 1,
    });
    renderSection({ state: "not-connected", relayOrigin: ORIGIN });

    fireEvent.click(button("Export…"));
    const [first, second] = passphraseFields();
    const confirm = () => within(dialog()).getByRole("button", { name: "Export history…" });
    expect(unavailable(confirm())).toBe(true);

    fireEvent.change(first, { target: { value: "too short" } });
    fireEvent.change(second, { target: { value: "too short" } });
    expect(unavailable(confirm())).toBe(true);

    fireEvent.change(first, { target: { value: PASSPHRASE } });
    fireEvent.change(second, { target: { value: `${PASSPHRASE}!` } });
    expect(within(dialog()).getByText("The passphrases don't match")).toBeTruthy();
    expect(unavailable(confirm())).toBe(true);

    fireEvent.change(second, { target: { value: PASSPHRASE } });
    expect(unavailable(confirm())).toBe(false);
    await act(async () => {
      fireEvent.click(confirm());
    });

    expect(exportData).toHaveBeenCalledExactlyOnceWith({ passphrase: PASSPHRASE });
    await gone("dialog");
    const row = document.getElementById("decisions-data-outcome")!;
    expect(within(row).getByText("Decision history exported")).toBeTruthy();
    expect(within(row).getByText(/3 questions and 1 audit event/)).toBeTruthy();
    expect(within(row).getByText(/decisions-export-2026-11-01\.dxz\.json/)).toBeTruthy();

    fireEvent.click(button("Export…"));
    expect(passphraseFields().map((field) => field.value)).toEqual(["", ""]);
  });

  it("keeps the export open with the reason when main couldn't export, and shows nothing for a cancel", async () => {
    exportData.mockRejectedValueOnce(new Error("The archive couldn't be written there"));
    exportData.mockResolvedValueOnce({ result: "cancelled" });
    renderSection({ state: "not-connected", relayOrigin: ORIGIN });

    const send = async () => {
      const [first, second] = passphraseFields();
      fireEvent.change(first, { target: { value: PASSPHRASE } });
      fireEvent.change(second, { target: { value: PASSPHRASE } });
      await act(async () => {
        fireEvent.click(within(dialog()).getByRole("button", { name: "Export history…" }));
      });
    };

    fireEvent.click(button("Export…"));
    await send();
    expect(within(dialog()).getByRole("alert").textContent).toContain("couldn't be written there");

    await send();
    await gone("dialog");
    expect(document.getElementById("decisions-data-outcome")).toBeNull();
  });

  it("forgets a passphrase typed into an export that was cancelled", async () => {
    renderSection({ state: "not-connected", relayOrigin: ORIGIN });

    fireEvent.click(button("Export…"));
    const [first, second] = passphraseFields();
    fireEvent.change(first, { target: { value: PASSPHRASE } });
    fireEvent.change(second, { target: { value: PASSPHRASE } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    await gone("dialog");

    fireEvent.click(button("Export…"));
    expect(passphraseFields().map((field) => field.value)).toEqual(["", ""]);
    expect(exportData).not.toHaveBeenCalled();
  });

  it("holds the export open and every action locked until main answers, sending one request", async () => {
    const reply = deferred<DecisionsExportResult>();
    exportData.mockReturnValue(reply.promise);
    renderSection({ state: "not-connected", relayOrigin: ORIGIN });

    fireEvent.click(button("Export…"));
    const [first, second] = passphraseFields();
    fireEvent.change(first, { target: { value: PASSPHRASE } });
    fireEvent.change(second, { target: { value: PASSPHRASE } });
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "Export history…" }));
    });

    expect(passphraseFields().map((field) => field.value)).toEqual(["", ""]);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    for (const name of ["Delete relay data", "Delete local data"]) {
      const action = screen
        .getAllByRole("button", { name, hidden: true })
        .find((element) => element.closest("[role=dialog]") === null);
      expect(action?.hasAttribute("disabled")).toBe(true);
    }

    await act(async () => {
      reply.resolve({ result: "cancelled" });
    });
    await gone("dialog");
    expect(exportData).toHaveBeenCalledOnce();
  });

  it("deletes the relay's data only once its address is typed, and says what the relay answered", async () => {
    deleteRelayData.mockResolvedValue({
      result: "unconfirmed",
      origin: ORIGIN,
      reason: "timeout",
    });
    renderSection({ state: "not-connected", relayOrigin: ORIGIN, keysStored: true });

    fireEvent.click(button("Delete relay data"));
    const confirm = () =>
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete relay data" });
    expect(unavailable(confirm())).toBe(true);

    fireEvent.change(within(screen.getByRole("alertdialog")).getByRole("textbox"), {
      target: { value: HOST },
    });
    expect(unavailable(confirm())).toBe(false);
    await act(async () => {
      fireEvent.click(confirm());
    });

    expect(deleteRelayData).toHaveBeenCalledExactlyOnceWith({ origin: ORIGIN });
    await gone("alertdialog");
    const row = document.getElementById("decisions-data-outcome")!;
    expect(within(row).getByText(`${HOST} didn't confirm the deletion`)).toBeTruthy();
    expect(within(row).getByText(/may have deleted some or all/)).toBeTruthy();
  });

  it("offers no relay deletion without a relay set up", () => {
    renderSection({ state: "not-connected" });

    expect(screen.queryByRole("button", { name: "Delete relay data" })).toBeNull();
    expect(button("Delete local data")).toBeTruthy();
  });

  it("deletes local data after the confirm and hands main's status on", async () => {
    const status: DecisionsStatus = { state: "not-connected", consentedAt: 5 };
    deleteLocalData.mockResolvedValue({ result: "deleted", status });
    const onChanged = vi.fn();
    renderSection({ state: "not-connected", relayOrigin: ORIGIN, keysStored: true }, { onChanged });

    fireEvent.click(button("Delete local data"));
    const confirmDialog = screen.getByRole("alertdialog");
    expect(confirmDialog.textContent).toContain(`Nothing on ${HOST} changes`);
    expect(confirmDialog.textContent).toContain("recovery kit");
    await act(async () => {
      fireEvent.click(within(confirmDialog).getByRole("button", { name: "Delete local data" }));
    });

    expect(deleteLocalData).toHaveBeenCalledOnce();
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(status);
    await gone("alertdialog");
    expect(
      within(document.getElementById("decisions-data-outcome")!).getByText("Local data deleted")
    ).toBeTruthy();
  });

  it("asks for main's status afresh when a local deletion failed", async () => {
    deleteLocalData.mockResolvedValue({ result: "failed", reason: "disk-pressure" });
    const onChanged = vi.fn();
    renderSection({ state: "not-connected" }, { onChanged });

    fireEvent.click(button("Delete local data"));
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete local data" })
      );
    });

    expect(onChanged).toHaveBeenCalledExactlyOnceWith(null);
    const row = document.getElementById("decisions-data-outcome")!;
    expect(within(row).getByText(/Disk space is critical/)).toBeTruthy();
    expect(within(row).getByText(/Nothing was deleted/)).toBeTruthy();
  });

  it("starts nothing while the switch is changing", () => {
    renderSection({ state: "not-connected", relayOrigin: ORIGIN }, { locked: true });

    for (const name of ["Export…", "Delete relay data", "Delete local data"]) {
      expect(button(name).disabled).toBe(true);
    }
  });
});
