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
    await screen.findByText(/Outcomes show up here/);
  });

  it("does not self-fetch when records are supplied (controlled)", async () => {
    render(<TurnOutcomeDiagnostics records={[]} />);

    // Controlled mode renders immediately without a loading round-trip.
    await screen.findByText(/Outcomes show up here/);
    expect(getTurnOutcomeRecords).not.toHaveBeenCalled();
  });

  it("renders the supplied records in controlled mode", async () => {
    render(<TurnOutcomeDiagnostics records={[sampleRecord]} />);

    // The turn count reflects the controlled prop, not an internal fetch.
    await screen.findByRole("button", { name: /Outcomes by class\s*1 turn/ });
    expect(getTurnOutcomeRecords).not.toHaveBeenCalled();
  });

  it("controlled Refresh delegates to onRefresh instead of self-fetching", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<TurnOutcomeDiagnostics records={[]} onRefresh={onRefresh} />);

    await screen.findByText(/Outcomes show up here/);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(getTurnOutcomeRecords).not.toHaveBeenCalled();
  });

  it("controlled Clear log clears the log then refreshes via onRefresh", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<TurnOutcomeDiagnostics records={[sampleRecord]} onRefresh={onRefresh} />);

    await screen.findByRole("button", { name: /Outcomes by class\s*1 turn/ });
    fireEvent.click(screen.getByRole("button", { name: "Clear turn outcomes…" }));

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear turn outcomes" }));

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

    await screen.findByRole("button", { name: /Outcomes by class\s*1 turn/ });
    fireEvent.click(screen.getByRole("button", { name: "Clear turn outcomes…" }));

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear turn outcomes" }));

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
    await screen.findByText(/Outcomes show up here/);

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => {
      expect(getTurnOutcomeRecords).toHaveBeenCalledTimes(2);
    });
  });

  it("tones every outcome's share the same way, good or bad", async () => {
    const make = (id: string, outcome: AssistantTurnRecord["outcome"]) => ({
      ...sampleRecord,
      id,
      outcome,
    });
    render(
      <TurnOutcomeDiagnostics
        records={[
          make("a", "answered"),
          make("b", "answered"),
          make("c", "tool-error"),
          make("d", "agent-stuck"),
        ]}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: /Outcomes by class/ }));

    const shareCell = (label: string) => {
      const row = screen.getByRole("rowheader", { name: label }).closest("tr")!;
      return row.querySelectorAll("td")[1]!;
    };
    // A rate colour reads as a verdict; the share of answered turns is not a problem.
    // Shares of 50%, 25% and 0% all read the same way.
    expect(shareCell("Answered").className).toBe(shareCell("Tool error").className);
    expect(shareCell("Answered").className).toBe(shareCell("Docs empty").className);
  });
});
