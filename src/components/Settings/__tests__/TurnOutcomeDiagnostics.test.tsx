// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
