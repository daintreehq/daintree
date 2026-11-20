// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileDocumentStore } from "@/store/fileDocumentStore";
import {
  _resetPluginFileDocumentsForTest,
  openPluginFileDocument,
  type PluginFileDocumentTarget,
} from "../pluginFileDocument";
import { scopeFileDocumentToView } from "../pluginFileDocumentViewScope";

const REV_A = "a".repeat(64);
const REV_B = "b".repeat(64);
const REV_C = "c".repeat(64);

const bridge = { read: vi.fn(), save: vi.fn() };

function target(): PluginFileDocumentTarget {
  return {
    panelId: "panel-1",
    projectId: "project-1",
    filePath: "/repo/content/a.json",
    fileName: "a.json",
    rootPath: "/repo",
    mode: "edit",
    maxBytes: 1024,
  };
}

const promptSave = () => useFileDocumentStore.getState().byPanelId["panel-1"]!.save();

describe("scopeFileDocumentToView (#17903)", () => {
  beforeEach(() => {
    bridge.read.mockReset();
    bridge.save.mockReset();
    Object.assign(window, { electron: { fileDocument: bridge } });
    useFileDocumentStore.setState({ byPanelId: {} });
  });

  afterEach(() => {
    _resetPluginFileDocumentsForTest();
  });

  it("drops a retired view's late draft, so the close prompt saves the new view's text against its base", async () => {
    // One host handle for the panel; the view inside it is remounted (a plugin
    // reload, Try again) without the host remounting.
    const host = openPluginFileDocument(target());
    host.retain();
    const oldView = scopeFileDocumentToView(host.document);
    const releaseOld = oldView.retain();
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "a", revision: REV_A });
    await expect(oldView.document.read()).resolves.toMatchObject({ revision: REV_A });

    releaseOld();
    await Promise.resolve();
    const newView = scopeFileDocumentToView(host.document);
    newView.retain();
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "b", revision: REV_B });
    await expect(newView.document.read()).resolves.toMatchObject({ revision: REV_B });
    newView.document.setDraft("b edited", { baseRevision: REV_B });

    // The old view's formatter finishes on the text it read.
    oldView.document.setDraft("a formatted", { baseRevision: REV_A });
    oldView.document.setConflict(true);
    await expect(
      oldView.document.save("a formatted", { expectedRevision: REV_A })
    ).resolves.toEqual({ status: "refused", reason: "unavailable" });
    expect(newView.document.getDraft()).toBe("b edited");
    expect(useFileDocumentStore.getState().byPanelId["panel-1"]).toMatchObject({
      draftText: "b edited",
      conflict: false,
    });

    bridge.save.mockResolvedValue({ status: "saved", revision: REV_C });
    await expect(promptSave()).resolves.toEqual({ status: "saved" });
    expect(bridge.save).toHaveBeenCalledTimes(1);
    expect(bridge.save).toHaveBeenCalledWith(
      expect.objectContaining({ text: "b edited", expectedRevision: REV_B })
    );
  });

  it("takes the flush a view makes in its own unmount cleanup, for the view that replaces it", () => {
    const host = openPluginFileDocument(target());
    host.retain();
    const oldView = scopeFileDocumentToView(host.document);
    const releaseOld = oldView.retain();
    oldView.document.setDraft("typed", { baseRevision: REV_A });

    // React runs the wrapper's cleanup before the view's own.
    releaseOld();
    oldView.document.setDraft("typed more", { baseRevision: REV_A });

    const newView = scopeFileDocumentToView(host.document);
    newView.retain();
    expect(newView.document.getDraft()).toBe("typed more");
    expect(newView.document.getDraftBaseRevision()).toBe(REV_A);
  });

  it("keeps a view remounted in the same commit (StrictMode) able to write", async () => {
    const host = openPluginFileDocument(target());
    host.retain();
    const view = scopeFileDocumentToView(host.document);
    view.retain()();
    view.retain();
    await Promise.resolve();
    view.document.setDraft("mine", { baseRevision: REV_A });
    expect(host.document.getDraft()).toBe("mine");
  });

  it("still lets the host's own fence drop a view whose host has gone", async () => {
    const host = openPluginFileDocument(target());
    const releaseHost = host.retain();
    const view = scopeFileDocumentToView(host.document);
    view.retain();
    releaseHost();
    await Promise.resolve();
    view.document.setDraft("late", { baseRevision: REV_A });
    expect(openPluginFileDocument(target()).document.getDraft()).toBeNull();
  });

  it("keeps a retired view's fields and draft readable, but answers its new reads unavailable", async () => {
    const host = openPluginFileDocument(target());
    host.retain();
    host.document.setDraft("draft", { baseRevision: REV_A });
    const view = scopeFileDocumentToView(host.document);
    view.retain()();
    await Promise.resolve();

    expect(view.document).toMatchObject({
      filePath: host.document.filePath,
      relativePath: "content/a.json",
      fileName: "a.json",
      mode: "edit",
      readOnly: false,
    });
    expect(Object.isFrozen(view.document)).toBe(true);
    expect(view.document.getDraft()).toBe("draft");
    expect(view.document.getDraftBaseRevision()).toBe(REV_A);
    await expect(view.document.read()).resolves.toEqual({ status: "unavailable" });
    expect(bridge.read).not.toHaveBeenCalled();
  });

  it("doesn't let a retired view's read hide a disk change from its successor", async () => {
    const host = openPluginFileDocument(target());
    host.retain();
    const oldView = scopeFileDocumentToView(host.document);
    oldView.retain()();
    await Promise.resolve();
    const newView = scopeFileDocumentToView(host.document);
    newView.retain();
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "b", revision: REV_B });
    await newView.document.read();
    const listener = vi.fn();
    newView.document.onDidChange(listener);

    // The disk moves to C; the old view's delayed refresh asks before the probe.
    bridge.read.mockResolvedValue({ status: "ok", text: "c", revision: REV_C });
    await expect(oldView.document.read()).resolves.toEqual({ status: "unavailable" });
    await host.notifyDiskChange();
    expect(listener).toHaveBeenCalledWith({ reason: "disk", revision: REV_C });
  });

  it("retires a released view as its dispose signal aborts, ahead of the view's own abort listeners", () => {
    const host = openPluginFileDocument(target());
    host.retain();
    const controller = new AbortController();
    const view = scopeFileDocumentToView(host.document, controller.signal);
    const release = view.retain();
    // Work the view tied to its dispose signal, holding an older snapshot.
    controller.signal.addEventListener("abort", () => {
      view.document.setDraft("from a stale snapshot", { baseRevision: REV_A });
    });
    view.document.setDraft("current", { baseRevision: REV_B });

    // The host's teardown releases the scope, then its queued dispose runs.
    release();
    view.document.setDraft("flushed on unmount", { baseRevision: REV_B });
    controller.abort();
    expect(host.document.getDraft()).toBe("flushed on unmount");
    expect(host.document.getDraftBaseRevision()).toBe(REV_B);
  });

  it("keeps a view whose dispose signal aborts while it is still mounted able to flush on unmount", async () => {
    const host = openPluginFileDocument(target());
    host.retain();
    const controller = new AbortController();
    const view = scopeFileDocumentToView(host.document, controller.signal);
    const release = view.retain();
    // A new attempt aborts the outgoing signal before the commit unmounts it.
    controller.abort();
    view.document.setDraft("typed", { baseRevision: REV_A });
    release();
    view.document.setDraft("flushed on unmount", { baseRevision: REV_A });
    expect(host.document.getDraft()).toBe("flushed on unmount");

    await Promise.resolve();
    view.document.setDraft("late", { baseRevision: REV_A });
    expect(host.document.getDraft()).toBe("flushed on unmount");
  });

  it("stays live while any hold remains, a repeated release counting once", async () => {
    const host = openPluginFileDocument(target());
    host.retain();
    const view = scopeFileDocumentToView(host.document);
    const first = view.retain();
    view.retain();
    first();
    first();
    await Promise.resolve();
    view.document.setDraft("mine", { baseRevision: REV_A });
    expect(host.document.getDraft()).toBe("mine");
  });

  it("unsubscribes the retired view's registrations from the document, and only those", async () => {
    const unsubscribes: ReturnType<typeof vi.fn>[] = [];
    const delegate = Object.freeze({
      ...openPluginFileDocument(target()).document,
      onDidChange: () => {
        const unsubscribe = vi.fn();
        unsubscribes.push(unsubscribe);
        return unsubscribe;
      },
    });
    const oldView = scopeFileDocumentToView(delegate);
    const releaseOld = oldView.retain();
    oldView.document.onDidChange(() => {});
    const newView = scopeFileDocumentToView(delegate);
    newView.retain();
    newView.document.onDidChange(() => {});
    releaseOld();
    await Promise.resolve();
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(unsubscribes[1]).not.toHaveBeenCalled();
  });

  it("drops a retired view's change listeners, never the same function its successor subscribed", async () => {
    const host = openPluginFileDocument(target());
    host.retain();
    // A module-level handler both mounts of the view register.
    const shared = vi.fn();
    const own = vi.fn();
    const oldView = scopeFileDocumentToView(host.document);
    const releaseOld = oldView.retain();
    oldView.document.onDidChange(shared);
    oldView.document.onDidChange(own);
    releaseOld();
    const newView = scopeFileDocumentToView(host.document);
    newView.retain();
    const unsubscribe = newView.document.onDidChange(shared);
    await Promise.resolve();
    const late = vi.fn();
    oldView.document.onDidChange(late);

    host.document.setDraft("draft", { baseRevision: REV_A });
    await useFileDocumentStore.getState().byPanelId["panel-1"]!.discard();
    expect(shared).toHaveBeenCalledTimes(1);
    expect(shared).toHaveBeenCalledWith(expect.objectContaining({ reason: "discarded" }));
    expect(own).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();

    unsubscribe();
    host.document.setDraft("again", { baseRevision: REV_A });
    await useFileDocumentStore.getState().byPanelId["panel-1"]!.discard();
    expect(shared).toHaveBeenCalledTimes(1);
  });

  it("keeps a retired viewer's save refused as read-only", async () => {
    const host = openPluginFileDocument({ ...target(), mode: "view" });
    host.retain();
    const view = scopeFileDocumentToView(host.document);
    view.retain()();
    await Promise.resolve();
    await expect(view.document.save("x", { expectedRevision: REV_A })).resolves.toEqual({
      status: "refused",
      reason: "read-only",
    });
    expect(bridge.save).not.toHaveBeenCalled();
  });
});
