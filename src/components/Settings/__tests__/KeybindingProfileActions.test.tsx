// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { notifyMock, exportProfile, importProfile, loadOverrides } = vi.hoisted(() => ({
  notifyMock: vi.fn(),
  exportProfile: vi.fn(),
  importProfile: vi.fn(),
  loadOverrides: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/services/KeybindingService", () => ({ keybindingService: { loadOverrides } }));

import { KeybindingProfileActions } from "../KeybindingProfileActions";

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "electron", {
    value: { keybinding: { exportProfile, importProfile } },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
});

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

describe("KeybindingProfileActions", () => {
  it("raises no notification when an export is saved", async () => {
    exportProfile.mockResolvedValue(true);
    render(<KeybindingProfileActions onImportComplete={vi.fn()} />);

    await click("Export");

    expect(exportProfile).toHaveBeenCalledTimes(1);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("raises no notification when an import applies shortcuts", async () => {
    importProfile.mockResolvedValue({ ok: true, applied: 3, skipped: 0, errors: [] });
    const onImportComplete = vi.fn();
    render(<KeybindingProfileActions onImportComplete={onImportComplete} />);

    await click("Import");

    expect(loadOverrides).toHaveBeenCalledTimes(1);
    expect(onImportComplete).toHaveBeenCalledTimes(1);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("still says so when an import applied nothing", async () => {
    importProfile.mockResolvedValue({ ok: true, applied: 0, skipped: 2, errors: [] });
    render(<KeybindingProfileActions onImportComplete={vi.fn()} />);

    await click("Import");

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]![0]).toMatchObject({ message: "No shortcuts were applied" });
  });

  it("still reports a failed import", async () => {
    importProfile.mockResolvedValue({ ok: false, errors: ["Bad file"] });
    render(<KeybindingProfileActions onImportComplete={vi.fn()} />);

    await click("Import");

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Import failed" })
    );
  });
});
