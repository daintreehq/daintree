import { describe, expect, it, vi } from "vitest";
import type { Dialog } from "electron";
import { cancelledResponse, installHeadlessDialogGuards } from "../headlessDialogs.js";

function fakeDialog(): Dialog {
  const crash = () => {
    throw new Error("a native dialog on a headless host");
  };
  return {
    showMessageBox: crash,
    showMessageBoxSync: crash,
    showErrorBox: crash,
    showOpenDialog: crash,
    showOpenDialogSync: crash,
    showSaveDialog: crash,
    showSaveDialogSync: crash,
  } as unknown as Dialog;
}

describe("headless dialog guards", () => {
  it("answers with the button a person would back out with", () => {
    expect(cancelledResponse({ message: "m", buttons: ["Quit", "Keep"], cancelId: 1 })).toBe(1);
    expect(cancelledResponse({ message: "m", buttons: ["Delete", "Cancel"] })).toBe(1);
    expect(cancelledResponse({ message: "m", buttons: ["Yes", "No"] })).toBe(1);
    expect(cancelledResponse({ message: "m", buttons: ["OK"] })).toBe(0);
    expect(cancelledResponse({ message: "m" })).toBe(0);
  });

  it("never reaches Chromium's dialogs, and says what it declined", async () => {
    const dialog = fakeDialog();
    const log = vi.fn();
    installHeadlessDialogGuards(dialog, log);

    const window = {} as never;
    await expect(
      dialog.showMessageBox(window, {
        message: "Quit while agents work?",
        buttons: ["Quit", "Cancel"],
      })
    ).resolves.toEqual({ response: 1, checkboxChecked: false });
    expect(dialog.showMessageBoxSync({ message: "m", buttons: ["OK"] })).toBe(0);
    expect(() => dialog.showErrorBox("Migration failed", "details")).not.toThrow();
    await expect(dialog.showOpenDialog({ title: "Pick" })).resolves.toEqual({
      canceled: true,
      filePaths: [],
    });
    await expect(dialog.showSaveDialog(window, { title: "Save" })).resolves.toMatchObject({
      canceled: true,
    });
    expect(dialog.showOpenDialogSync({})).toBeUndefined();
    expect(dialog.showSaveDialogSync({})).toBe("");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Quit while agents work?"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Migration failed: details"));
  });
});
