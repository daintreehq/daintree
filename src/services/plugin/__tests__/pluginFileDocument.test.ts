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
    handle.document.setDraft('{"a":1}', { baseRevision: REV_A });
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
    handle.document.setDraft("mine", { baseRevision: REV_A });
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
    handle.document.setDraft("mine", { baseRevision: REV_A });
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
    handle.document.setDraft("mine", { baseRevision: REV_A });
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
    handle.document.setDraft("mine", { baseRevision: REV_A });
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
      handle.document.setDraft("mine", { baseRevision: REV_A });
      await expect(useFileDocumentStore.getState().byPanelId["panel-1"]!.save()).resolves.toEqual(
        outcome
      );
      expect(handle.document.getDraft()).toBe("mine");
      expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.dirty).toBe(true);
    }
  );

  it("doesn't report saved when newer edits landed while the close prompt's Save ran", async () => {
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "{}", revision: REV_A });
    let release: (value: unknown) => void = () => {};
    bridge.save.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const handle = openPluginFileDocument(target());
    handle.retain();
    await handle.document.read();
    handle.document.setDraft("first", { baseRevision: REV_A });
    const saving = useFileDocumentStore.getState().byPanelId["panel-1"]!.save();
    handle.document.setDraft("second");
    release({ status: "saved", revision: REV_B });
    await expect(saving).resolves.toEqual({
      status: "refused",
      reason: "Edits made during the save are still unsaved",
    });
    expect(handle.document.getDraft()).toBe("second");
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.dirty).toBe(true);

    // The newer edits sit on top of what that save wrote.
    bridge.save.mockResolvedValue({ status: "saved", revision: REV_C });
    await useFileDocumentStore.getState().byPanelId["panel-1"]!.save();
    expect(bridge.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "second", expectedRevision: REV_B })
    );
  });

  it("refuses the close prompt's Save for a draft started without a base revision", async () => {
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "{}", revision: REV_A });
    const handle = openPluginFileDocument(target());
    handle.retain();
    // A read the editor may or may not have applied is no base.
    await handle.document.read();
    handle.document.setDraft("mine");
    await expect(useFileDocumentStore.getState().byPanelId["panel-1"]!.save()).resolves.toEqual({
      status: "refused",
      reason: "The editor didn't say which version of the file these edits are based on",
    });
    expect(bridge.save).not.toHaveBeenCalled();
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]).toMatchObject({
      dirty: true,
      draftText: "mine",
    });
  });

  it("never rebases a standing draft on a re-read, so the close prompt can't overwrite a change", async () => {
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "{}", revision: REV_A });
    bridge.save.mockResolvedValue({ status: "conflict", revision: REV_B });
    const handle = openPluginFileDocument(target());
    handle.retain();
    await handle.document.read();
    handle.document.setDraft("mine", { baseRevision: REV_A });
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
    handle.document.setDraft("mine", { baseRevision: REV_A });
    const listener = vi.fn();
    handle.document.onDidChange(listener);
    bridge.read.mockResolvedValue({ status: "too-large" });
    await handle.notifyDiskChange();
    await handle.notifyDiskChange();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ reason: "disk", revision: null });
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.conflict).toBe(true);
  });

  it("tells a view whose first read was refused once the file reads again", async () => {
    bridge.read.mockResolvedValueOnce({ status: "unavailable" });
    const handle = openPluginFileDocument(target({ mode: "view" }));
    handle.retain();
    await expect(handle.document.read()).resolves.toEqual({ status: "unavailable" });
    const listener = vi.fn();
    handle.document.onDidChange(listener);
    bridge.read.mockResolvedValue({ status: "ok", text: "a,b", revision: REV_A });
    await handle.notifyDiskChange();
    await handle.notifyDiskChange();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ reason: "disk", revision: REV_A });
  });

  it("tells a view whose first read threw once the file reads", async () => {
    bridge.read.mockRejectedValueOnce(new Error("link dropped"));
    const handle = openPluginFileDocument(target({ mode: "view" }));
    handle.retain();
    await expect(handle.document.read()).resolves.toEqual({ status: "unavailable" });
    const listener = vi.fn();
    handle.document.onDidChange(listener);
    bridge.read.mockResolvedValue({ status: "ok", text: "a,b", revision: REV_A });
    await handle.notifyDiskChange();
    expect(listener).toHaveBeenCalledWith({ reason: "disk", revision: REV_A });
  });

  it("tells a view showing a refusal when the file goes back to the revision it had", async () => {
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "a,b", revision: REV_A });
    const handle = openPluginFileDocument(target({ mode: "view" }));
    handle.retain();
    await handle.document.read();
    const listener = vi.fn();
    handle.document.onDidChange(listener);

    bridge.read.mockResolvedValue({ status: "not-text" });
    await handle.notifyDiskChange();
    await handle.document.read();
    expect(listener).toHaveBeenCalledTimes(1);

    bridge.read.mockResolvedValue({ status: "ok", text: "a,b", revision: REV_A });
    await handle.notifyDiskChange();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({ reason: "disk", revision: REV_A });
  });

  it("makes the view read again when a check overtakes its first read", async () => {
    let finishFirst: (value: unknown) => void = () => {};
    bridge.read.mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)));
    const handle = openPluginFileDocument(target({ mode: "view" }));
    handle.retain();
    const listener = vi.fn();
    handle.document.onDidChange(listener);
    const first = handle.document.read();

    bridge.read.mockResolvedValueOnce({ status: "ok", text: "new", revision: REV_B });
    await handle.notifyDiskChange();
    finishFirst({ status: "ok", text: "old", revision: REV_A });
    await first;
    await Promise.resolve();

    expect(listener).toHaveBeenCalledWith({ reason: "disk", revision: REV_B });
  });

  it("still conflicts a draft on the next check after a read saw the file stop reading", async () => {
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "{}", revision: REV_A });
    const handle = openPluginFileDocument(target());
    handle.retain();
    await handle.document.read();
    handle.document.setDraft("mine", { baseRevision: REV_A });

    bridge.read.mockResolvedValue({ status: "not-text" });
    await handle.document.read();
    await handle.notifyDiskChange();
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.conflict).toBe(true);
  });

  it("never conflicts a draft over a stale read", async () => {
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "{}", revision: REV_A });
    const handle = openPluginFileDocument(target());
    handle.retain();
    await handle.document.read();
    handle.document.setDraft("mine", { baseRevision: REV_A });
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "{}", revision: REV_B });
    await handle.document.read();
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.conflict).toBe(false);
  });

  it("checks again for a change asked about while the last check was finishing", async () => {
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "{}", revision: REV_A });
    const handle = openPluginFileDocument(target({ mode: "view" }));
    handle.retain();
    await handle.document.read();
    const listener = vi.fn();
    handle.document.onDidChange(listener);

    bridge.read.mockResolvedValueOnce({ status: "ok", text: "{}", revision: REV_B });
    const first = handle.notifyDiskChange();
    // Lands once the first check's read has answered, before its runner returns.
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "{}", revision: REV_C });
    await Promise.resolve();
    await Promise.resolve();
    const second = handle.notifyDiskChange();
    await Promise.all([first, second]);
    expect(listener).toHaveBeenLastCalledWith({ reason: "disk", revision: REV_C });
  });

  it("keeps the draft owner's save ceiling when a viewer opens the same document", async () => {
    bridge.read.mockResolvedValue({ status: "ok", text: "{}", revision: REV_A });
    bridge.save.mockResolvedValue({ status: "saved", revision: REV_B });
    const editor = openPluginFileDocument(target({ maxBytes: 10 }));
    editor.retain();
    await editor.document.read();
    editor.document.setDraft("mine", { baseRevision: REV_A });

    const viewer = openPluginFileDocument(target({ mode: "view", maxBytes: 2048 }));
    await viewer.document.read();
    expect(bridge.read).toHaveBeenLastCalledWith(expect.objectContaining({ maxBytes: 2048 }));

    await useFileDocumentStore.getState().byPanelId["panel-1"]!.save();
    expect(bridge.save).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 10 }));
  });

  it("runs one disk check at a time, and one more for changes meanwhile", async () => {
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "{}", revision: REV_A });
    const handle = openPluginFileDocument(target({ mode: "view" }));
    handle.retain();
    await handle.document.read();
    bridge.read.mockClear();
    let finish: (value: unknown) => void = () => {};
    bridge.read.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    bridge.read.mockResolvedValue({ status: "ok", text: "{}", revision: REV_C });

    const checks = [
      handle.notifyDiskChange(),
      handle.notifyDiskChange(),
      handle.notifyDiskChange(),
    ];
    finish({ status: "ok", text: "{}", revision: REV_B });
    await Promise.all(checks);
    expect(bridge.read).toHaveBeenCalledTimes(2);
  });

  it("never lets a superseded read move the revision a draft is saved against", async () => {
    let finishFirst: (value: unknown) => void = () => {};
    bridge.read.mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)));
    bridge.save.mockResolvedValue({ status: "conflict", revision: REV_B });
    const handle = openPluginFileDocument(target());
    handle.retain();
    const first = handle.document.read();
    // The editor reads again (a change arrived) and holds A.
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "a", revision: REV_A });
    await handle.document.read();
    // B is written; the first read, which sampled it, lands last.
    finishFirst({ status: "ok", text: "b", revision: REV_B });
    await first;

    handle.document.setDraft("edited from a", { baseRevision: REV_A });
    await useFileDocumentStore.getState().byPanelId["panel-1"]!.save();
    expect(bridge.save).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: REV_A }));
  });

  it.each([
    ["after the newer read failed", true],
    ["before the newer read failed", false],
  ])(
    "saves the draft of an editor that applies every answer against the text it holds, the older read landing %s",
    async (_order, newerFirst) => {
      bridge.read.mockResolvedValueOnce({ status: "ok", text: "b", revision: REV_B });
      bridge.save.mockResolvedValue({ status: "saved", revision: REV_C });
      const handle = openPluginFileDocument(target());
      handle.retain();
      // Applies each answer as it lands and keeps its last good text when a read fails.
      let held = { text: "", revision: "" };
      const apply = (result: Awaited<ReturnType<typeof handle.document.read>>) => {
        if (result.status === "ok") held = { text: result.text, revision: result.revision };
      };
      apply(await handle.document.read());

      let finishOlder: (value: unknown) => void = () => {};
      let failNewer: (reason: unknown) => void = () => {};
      bridge.read.mockImplementationOnce(() => new Promise((resolve) => (finishOlder = resolve)));
      bridge.read.mockImplementationOnce(
        () => new Promise((_resolve, reject) => (failNewer = reject))
      );
      const older = handle.document.read().then(apply);
      const newer = handle.document.read().then(apply);
      if (newerFirst) {
        failNewer(new Error("link dropped"));
        await newer;
        finishOlder({ status: "ok", text: "a", revision: REV_A });
      } else {
        finishOlder({ status: "ok", text: "a", revision: REV_A });
        await Promise.resolve();
        failNewer(new Error("link dropped"));
      }
      await Promise.all([older, newer]);

      handle.document.setDraft(`${held.text} edited`, { baseRevision: held.revision });
      await useFileDocumentStore.getState().byPanelId["panel-1"]!.save();
      expect(bridge.save).toHaveBeenCalledWith(
        expect.objectContaining({ text: `${held.text} edited`, expectedRevision: held.revision })
      );
    }
  );

  it.each([
    ["a clean re-read by the editor", "edit" as const, 1024],
    ["a roomier viewer's read", "view" as const, 4096],
  ])(
    "saves a draft against the text the editor still shows, not %s it hasn't applied",
    async (_reader, mode, maxBytes) => {
      bridge.read.mockResolvedValueOnce({ status: "ok", text: "a", revision: REV_A });
      // The disk is at B by the time the close prompt saves: only a write
      // against B would land.
      bridge.save.mockImplementation(async ({ expectedRevision }) =>
        expectedRevision === REV_B
          ? { status: "saved", revision: REV_C }
          : { status: "conflict", revision: REV_B }
      );
      const editor = openPluginFileDocument(target());
      editor.retain();
      await editor.document.read();
      const reader = mode === "edit" ? editor : openPluginFileDocument(target({ mode, maxBytes }));
      bridge.read.mockResolvedValueOnce({ status: "ok", text: "b", revision: REV_B });
      await reader.document.read();

      // The editor is still showing A when the user types.
      editor.document.setDraft("a edited", { baseRevision: REV_A });
      await expect(useFileDocumentStore.getState().byPanelId["panel-1"]!.save()).resolves.toEqual({
        status: "conflict",
        reason: "The file changed on disk",
      });
      expect(bridge.save).toHaveBeenCalledWith(
        expect.objectContaining({ text: "a edited", expectedRevision: REV_A })
      );
      expect(editor.document.getDraft()).toBe("a edited");
    }
  );

  it("keeps the base a draft started with when a remounted editor reports another", async () => {
    bridge.save.mockResolvedValue({ status: "conflict", revision: REV_B });
    const first = openPluginFileDocument(target());
    const release = first.retain();
    first.document.setDraft("draft", { baseRevision: REV_A });
    release();

    const second = openPluginFileDocument(target());
    second.retain();
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "theirs", revision: REV_B });
    const fresh = await second.document.read();
    second.document.setDraft(`${second.document.getDraft()} more`, {
      baseRevision: fresh.status === "ok" ? fresh.revision : "",
    });
    await useFileDocumentStore.getState().byPanelId["panel-1"]!.save();
    expect(bridge.save).toHaveBeenCalledWith(
      expect.objectContaining({ text: "draft more", expectedRevision: REV_A })
    );
  });

  it("leaves a draft started during a save alone when that save's reply lands", async () => {
    let finishSave: (value: unknown) => void = () => {};
    bridge.save.mockImplementationOnce(() => new Promise((resolve) => (finishSave = resolve)));
    const handle = openPluginFileDocument(target());
    handle.retain();
    handle.document.setDraft("same", { baseRevision: REV_A });
    const saving = useFileDocumentStore.getState().byPanelId["panel-1"]!.save();

    // Discarded and started again from another revision, with the same text.
    await useFileDocumentStore.getState().byPanelId["panel-1"]!.discard();
    handle.document.setDraft("same", { baseRevision: REV_C });
    finishSave({ status: "saved", revision: REV_B });
    await saving;
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]).toMatchObject({
      dirty: true,
      draftText: "same",
    });

    bridge.save.mockResolvedValue({ status: "saved", revision: REV_A });
    await useFileDocumentStore.getState().byPanelId["panel-1"]!.save();
    expect(bridge.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "same", expectedRevision: REV_C })
    );
  });

  it("never conflicts a roomier editor's draft over a viewer's tighter ceiling", async () => {
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "{}", revision: REV_A });
    const editor = openPluginFileDocument(target({ maxBytes: 4096 }));
    editor.retain();
    await editor.document.read();
    editor.document.setDraft("mine", { baseRevision: REV_A });

    const viewer = openPluginFileDocument(target({ mode: "view", maxBytes: 16 }));
    bridge.read.mockResolvedValue({ status: "too-large" });
    await viewer.notifyDiskChange();
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]?.conflict).toBe(false);
  });

  it("reports every move of the disk, back to an earlier revision included", async () => {
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "{}", revision: REV_A });
    const handle = openPluginFileDocument(target());
    handle.retain();
    await handle.document.read();
    handle.document.setDraft("mine", { baseRevision: REV_A });
    const listener = vi.fn();
    handle.document.onDidChange(listener);

    for (const revision of [REV_B, REV_A, REV_B]) {
      bridge.read.mockResolvedValueOnce({ status: "ok", text: "{}", revision });
      await handle.notifyDiskChange();
    }
    expect(listener.mock.calls.map(([change]) => change.revision)).toEqual([REV_B, REV_A, REV_B]);
  });

  it("stays quiet on a disk change before anything was read", async () => {
    const handle = openPluginFileDocument(target({ mode: "view" }));
    handle.retain();
    const listener = vi.fn();
    handle.document.onDidChange(listener);
    bridge.read.mockResolvedValue({ status: "ok", text: "a,b", revision: REV_A });
    await handle.notifyDiskChange();
    expect(listener).not.toHaveBeenCalled();
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
