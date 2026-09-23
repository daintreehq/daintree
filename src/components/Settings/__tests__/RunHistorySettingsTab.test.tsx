// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunHistoryRecord } from "@shared/types";

const clear = vi.fn<() => Promise<boolean>>();
let records: RunHistoryRecord[] = [];

vi.mock("@/store/runHistoryStore", () => ({
  useRunHistoryStore: <T,>(
    selector: (s: {
      records: RunHistoryRecord[];
      loading: boolean;
      init: () => void;
      clear: () => Promise<boolean>;
    }) => T
  ) => selector({ records, loading: false, init: () => {}, clear }),
}));

const { RunHistorySettingsTab } = await import("../RunHistorySettingsTab");

function fleet(overrides: Partial<Extract<RunHistoryRecord, { kind: "fleet" }>> = {}) {
  return {
    id: "f1",
    schemaVersion: 1,
    kind: "fleet",
    timestamp: Date.now(),
    targetCount: 1,
    successCount: 0,
    failureCount: 0,
    cancelled: false,
    perTarget: [],
    ...overrides,
  } as RunHistoryRecord;
}

describe("RunHistorySettingsTab", () => {
  beforeEach(() => {
    clear.mockReset();
    records = [fleet()];
  });

  it("closes the confirm once the clear has landed", async () => {
    clear.mockResolvedValue(true);
    render(<RunHistorySettingsTab />);

    fireEvent.click(screen.getByRole("button", { name: "Clear history…" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear history" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(clear).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/couldn't be cleared/)).toBeNull();
  });

  it("says so when the clear fails, instead of looking done", async () => {
    clear.mockResolvedValue(false);
    render(<RunHistorySettingsTab />);

    fireEvent.click(screen.getByRole("button", { name: "Clear history…" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear history" }));

    await screen.findByText(/couldn't be cleared/);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("agrees every count with its number", () => {
    records = [
      fleet({ id: "one", targetCount: 1 }),
      fleet({ id: "two", targetCount: 2, timestamp: Date.now() - 1000 }),
    ];
    render(<RunHistorySettingsTab />);
    expect(screen.getByText("1 target")).toBeTruthy();
    expect(screen.queryByText("1 targets")).toBeNull();
    expect(screen.getByText("2 targets")).toBeTruthy();
  });
});
