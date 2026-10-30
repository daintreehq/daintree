// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunHistoryRecord } from "@shared/types";

const clear = vi.fn<() => Promise<boolean>>();
const retry = vi.fn();
let records: RunHistoryRecord[] = [];
let loadFailed = false;

vi.mock("@/store/runHistoryStore", () => ({
  useRunHistoryStore: <T,>(
    selector: (s: {
      records: RunHistoryRecord[];
      loading: boolean;
      loadFailed: boolean;
      init: () => void;
      retry: () => void;
      clear: () => Promise<boolean>;
    }) => T
  ) => selector({ records, loading: false, loadFailed, init: () => {}, retry, clear }),
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
    retry.mockReset();
    records = [fleet()];
    loadFailed = false;
  });

  it("says the history couldn't be loaded, not that it is empty, with a retry", () => {
    records = [];
    loadFailed = true;
    render(<RunHistorySettingsTab />);
    expect(screen.getByRole("alert").textContent).toMatch(/couldn't be loaded/);
    expect(screen.queryByText(/outcome shows up here/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps the runs on screen beside the notice when a read fails", () => {
    loadFailed = true;
    render(<RunHistorySettingsTab />);
    expect(screen.getByRole("alert").textContent).toMatch(/couldn't be refreshed/);
    expect(screen.getByText("Fleet broadcast")).toBeTruthy();
  });

  it("shows the empty message only when the read succeeded", () => {
    records = [];
    render(<RunHistorySettingsTab />);
    expect(screen.getByText(/outcome shows up here/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
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
