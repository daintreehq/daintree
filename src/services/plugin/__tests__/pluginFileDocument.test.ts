// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileDocumentStore } from "@/store/fileDocumentStore";
import {
  _resetPluginFileDocumentsForTest,
  openPluginFileDocument,
  type PluginFileDocumentTarget,
} from "../pluginFileDocument";

const REV_A = "a".repeat(64);
const REV_B = "b".repeat(64);
const REV_C = "c".repeat(64);

const bridge = {
  read: vi.fn(),
  save: vi.fn(),
};

function target(overrides: Partial<PluginFileDocumentTarget> = {}): PluginFileDocumentTarget {
  return {
    panelId: "panel-1",
    projectId: "project-1",
    filePath: "/repo/content/a.json",
    fileName: "a.json",
    rootPath: "/repo",
    mode: "edit",
    maxBytes: 1024,
    ...overrides,
  };
}

describe("pluginFileDocument (#13809)", () => {
  beforeEach(() => {
    bridge.read.mockReset();
    bridge.save.mockReset();
    Object.assign(window, { electron: { fileDocument: bridge } });
    useFileDocumentStore.setState({ byPanelId: {} });
  });

  afterEach(() => {
    _resetPluginFileDocumentsForTest();
  });

  it("reads through main with the panel's root and the editor's ceiling", async () => {
    bridge.read.mockResolvedValue({ status: "ok", text: "{}", revision: REV_A });
    const { document } = openPluginFileDocument(target());
    expect(document.relativePath).toBe("content/a.json");
    await expect(document.read()).resolves.toEqual({ status: "ok", text: "{}", revision: REV_A });
    expect(bridge.read).toHaveBeenCalledWith({
      rootPath: "/repo",
      filePath: "/repo/content/a.json",
      maxBytes: 1024,
    });
  });

  it("publishes the draft to the host projection and saves it from the close prompt", async () => {
    bridge.read.mockResolvedValue({ status: "ok", text: "{}", revision: REV_A });
    bridge.save.mockResolvedValue({ status: "saved", revision: REV_B });
    const handle = openPluginFileDocument(target());
    const release = handle.retain();
    await handle.document.read();
    handle.document.setDraft('{"a":1}');
    const projection = useFileDocumentStore.getState().byPanelId["panel-1"];
    expect(projection).toMatchObject({ dirty: true, draftText: '{"a":1}', conflict: false });

    // The view goes away (the user switched to Source); the draft stays the host's.
    release();
    const listener = vi.fn();
    handle.document.onDidChange(listener);
    await expect(useFileDocumentStore.getState().byPanelId["panel-1"]!.save()).resolves.toEqual({
      status: "saved",
    });
    expect(bridge.save).toHaveBeenCalledWith(
      expect.objectContaining({ text: '{"a":1}', expectedRevision: REV_A })
    );
    expect(listener).toHaveBeenCalledWith({ reason: "saved", revision: REV_B });
    // Clean and unmounted: released.
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]).toBeUndefined();
  });

  it("keeps the draft across a remount of the same panel and file", () => {
    const first = openPluginFileDocument(target());
    const release = first.retain();
    first.document.setDraft("draft");
    release();
    const second = openPluginFileDocument(target());
    expect(second.document.getDraft()).toBe("draft");
  });

  it("marks a stale save as a conflict and keeps the draft", async () => {
    bridge.read.mockResolvedValue({ status: "ok", text: "{}", revision: REV_A });
    bridge.save.mockResolvedValue({ status: "conflict", revision: REV_C });
    const handle = openPluginFileDocument(target());
    handle.retain();
    await handle.document.read();
    handle.document.setDraft("mine");
    await expect(handle.document.save("mine", { expectedRevision: REV_A })).resolves.toEqual({
      status: "conflict",
      revision: REV_C,
    });
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]).toMatchObject({
      dirty: true,
      conflict: true,
      draftText: "mine",
    });
  });

  it("hands a save refused for another screen's lease the host's words, and keeps the draft", async () => {
    const wording = "greg-mbp has control of this project. Take control first.";
    bridge.read.mockResolvedValue({ status: "ok", text: "{}", revision: REV_A });
    // As the preload rethrows a host AppError across the bridge.
    bridge.save.mockRejectedValue(
      new Error(
        `[AppError|DRIVEN_ELSEWHERE|${encodeURIComponent(wording)}] file-document:save changes p1`
      )
    );
    const handle = openPluginFileDocument(target());
    handle.retain();
    await handle.document.read();
    handle.document.setDraft("mine");
    await expect(handle.document.save("mine", { expectedRevision: REV_A })).resolves.toEqual({
      status: "error",
      message: wording,
    });
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]).toMatchObject({
      dirty: true,
      draftText: "mine",
    });
  });

  it("raises a conflict when the disk moves under a draft, and reports it once", async () => {
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "{}", revision: REV_A });
    const handle = openPluginFileDocument(target());
    handle.retain();
    await handle.document.read();
    handle.document.setDraft("mine");
    const listener = vi.fn();
    handle.document.onDidChange(listener);

    bridge.read.mockResolvedValue({ status: "ok", text: "theirs", revision: REV_B });
    await handle.notifyDiskChange();
    await handle.notifyDiskChange();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ reason: "disk", revision: REV_B });
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.conflict).toBe(true);
  });

  it("does not let the editor clear a conflict the host observed", async () => {
    bridge.read.mockResolvedValue({ status: "ok", text: "{}", revision: REV_A });
    bridge.save.mockResolvedValue({ status: "conflict", revision: REV_B });
    const handle = openPluginFileDocument(target());
    handle.retain();
    await handle.document.read();
    handle.document.setDraft("mine");
    await handle.document.save("mine", { expectedRevision: REV_A });
    handle.document.setConflict(false);
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.conflict).toBe(true);
  });

  it("discards through the projection and tells the view to re-read", async () => {
    const handle = openPluginFileDocument(target());
    handle.retain();
    handle.document.setDraft("mine");
    const listener = vi.fn();
    handle.document.onDidChange(listener);
    await useFileDocumentStore.getState().byPanelId["panel-1"]!.discard();
    expect(handle.document.getDraft()).toBeNull();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ reason: "discarded" }));
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.dirty).toBe(false);
  });

  it.each([
    [
      { status: "error", message: "Disk full" },
      { status: "error", reason: "Disk full" },
    ],
    [
      { status: "refused", reason: "unavailable" },
      { status: "unavailable", reason: "The file isn't where it was" },
    ],
    [
      { status: "refused", reason: "too-large" },
      { status: "refused", reason: "The draft is too large for this editor to save" },
    ],
  ])(
    "the close prompt's Save names why %o didn't land and keeps the draft (#15017)",
    async (result, outcome) => {
      bridge.read.mockResolvedValueOnce({ status: "ok", text: "{}", revision: REV_A });
      bridge.save.mockResolvedValue(result);
      const handle = openPluginFileDocument(target());
      handle.retain();
      await handle.document.read();
      handle.document.setDraft("mine");
      await expect(useFileDocumentStore.getState().byPanelId["panel-1"]!.save()).resolves.toEqual(
        outcome
      );
      expect(handle.document.getDraft()).toBe("mine");
      expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.dirty).toBe(true);
    }
  );

  it("refuses the close prompt's Save for a draft with no revision read yet", async () => {
    const handle = openPluginFileDocument(target());
    handle.retain();
    handle.document.setDraft("mine");
    await expect(useFileDocumentStore.getState().byPanelId["panel-1"]!.save()).resolves.toEqual({
      status: "refused",
      reason: "The file hasn't finished loading",
    });
    expect(bridge.save).not.toHaveBeenCalled();
  });

  it("never rebases a standing draft on a re-read, so the close prompt can't overwrite a change", async () => {
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "{}", revision: REV_A });
    bridge.save.mockResolvedValue({ status: "conflict", revision: REV_B });
    const handle = openPluginFileDocument(target());
    handle.retain();
    await handle.document.read();
    handle.document.setDraft("mine");
    // The disk moved on and a remounted view re-reads it.
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "theirs", revision: REV_B });
    await handle.document.read();
    await expect(useFileDocumentStore.getState().byPanelId["panel-1"]!.save()).resolves.toEqual({
      status: "conflict",
      reason: "The file changed on disk",
    });
    expect(bridge.save).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: REV_A }));
  });

  it("reports a file that stopped reading as text as a change, and conflicts the draft", async () => {
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "{}", revision: REV_A });
    const handle = openPluginFileDocument(target());
    handle.retain();
    await handle.document.read();
    handle.document.setDraft("mine");
    const listener = vi.fn();
    handle.document.onDidChange(listener);
    bridge.read.mockResolvedValue({ status: "too-large" });
    await handle.notifyDiskChange();
    await handle.notifyDiskChange();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ reason: "disk", revision: null });
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.conflict).toBe(true);
  });

  it("releases a clean record on unmount even with a conflict reported", () => {
    const handle = openPluginFileDocument(target());
    const release = handle.retain();
    handle.document.setConflict(true);
    release();
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]).toBeUndefined();
  });

  it("does not let a stale record's late save clear a newer record's projection", async () => {
    bridge.read.mockResolvedValue({ status: "ok", text: "{}", revision: REV_A });
    let finishSave: (value: unknown) => void = () => {};
    bridge.save.mockReturnValueOnce(new Promise((resolve) => (finishSave = resolve)));
    const old = openPluginFileDocument(target());
    const releaseOld = old.retain();
    await old.document.read();
    const saving = old.document.save("x", { expectedRevision: REV_A });
    old.document.setDraft(null);
    releaseOld();

    const fresh = openPluginFileDocument(target());
    fresh.retain();
    fresh.document.setDraft("newer");
    finishSave({ status: "saved", revision: REV_B });
    await saving;
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]).toMatchObject({
      dirty: true,
      draftText: "newer",
    });
  });

  it("gives a view editor a read-only document", async () => {
    const { document } = openPluginFileDocument(target({ mode: "view" }));
    expect(document.readOnly).toBe(true);
    await expect(document.save("x", { expectedRevision: REV_A })).resolves.toEqual({
      status: "refused",
      reason: "read-only",
    });
    document.setDraft("x");
    expect(document.getDraft()).toBeNull();
    expect(bridge.save).not.toHaveBeenCalled();
  });
});
