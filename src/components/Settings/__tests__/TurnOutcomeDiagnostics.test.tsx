// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { TurnOutcomeDiagnostics } from "../TurnOutcomeDiagnostics";
import type { AssistantTurnRecord } from "@shared/types";

const getTurnOutcomeRecords = vi.fn();
const clearTurnOutcomeLog = vi.fn();

function installApi() {
  getTurnOutcomeRecords.mockResolvedValue([]);
  clearTurnOutcomeLog.mockResolvedValue(undefined);
  window.electron = {
    mcpServer: { getTurnOutcomeRecords, clearTurnOutcomeLog },
  } as unknown as typeof window.electron;
}

const sampleRecord: AssistantTurnRecord = {
  sessionId: "help-1",
  outcome: "answered",
} as unknown as AssistantTurnRecord;

describe("TurnOutcomeDiagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installApi();
  });

  it("self-fetches turn-outcome records on mount when uncontrolled", async () => {
    render(<TurnOutcomeDiagnostics />);

    await waitFor(() => {
      expect(getTurnOutcomeRecords).toHaveBeenCalledTimes(1);
    });
    await screen.findByText("Turn outcomes by class");
  });

  it("does not self-fetch when records are supplied (controlled)", async () => {
    render(<TurnOutcomeDiagnostics records={[]} />);

    // Controlled mode renders immediately without a loading round-trip.
    await screen.findByText("Turn outcomes by class");
    expect(getTurnOutcomeRecords).not.toHaveBeenCalled();
  });

  it("renders the supplied records in controlled mode", async () => {
    render(<TurnOutcomeDiagnostics records={[sampleRecord]} />);

    // The turn count reflects the controlled prop, not an internal fetch.
    await screen.findByText("(1 turns)");
    expect(getTurnOutcomeRecords).not.toHaveBeenCalled();
  });

  it("controlled Refresh delegates to onRefresh instead of self-fetching", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<TurnOutcomeDiagnostics records={[]} onRefresh={onRefresh} />);

    await screen.findByText("Turn outcomes by class");
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(getTurnOutcomeRecords).not.toHaveBeenCalled();
  });

  it("controlled Clear log clears the log then refreshes via onRefresh", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<TurnOutcomeDiagnostics records={[sampleRecord]} onRefresh={onRefresh} />);

    await screen.findByText("(1 turns)");
    fireEvent.click(screen.getByRole("button", { name: "Clear log" }));

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear log" }));

    await waitFor(() => {
      expect(clearTurnOutcomeLog).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
    // Controlled mode never touches the internal self-fetch path.
    expect(getTurnOutcomeRecords).not.toHaveBeenCalled();
  });

  it("controlled Clear log still closes the dialog when onRefresh rejects", async () => {
    const onRefresh = vi.fn().mockRejectedValue(new Error("refresh boom"));
    render(<TurnOutcomeDiagnostics records={[sampleRecord]} onRefresh={onRefresh} />);

    await screen.findByText("(1 turns)");
    fireEvent.click(screen.getByRole("button", { name: "Clear log" }));

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear log" }));

    await waitFor(() => {
      expect(clearTurnOutcomeLog).toHaveBeenCalledTimes(1);
    });
    // Clear committed, so the dialog must not linger or re-surface despite the
    // post-clear refresh failure.
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  });

  it("uncontrolled Refresh re-fetches records", async () => {
    render(<TurnOutcomeDiagnostics />);

    await waitFor(() => {
      expect(getTurnOutcomeRecords).toHaveBeenCalledTimes(1);
    });
    await screen.findByText("Turn outcomes by class");

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => {
      expect(getTurnOutcomeRecords).toHaveBeenCalledTimes(2);
    });
  });
});
