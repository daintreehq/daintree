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

  it("reads through for a retired view, and keeps the document's fields", async () => {
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
    bridge.read.mockResolvedValueOnce({ status: "ok", text: "a", revision: REV_A });
    await expect(view.document.read()).resolves.toMatchObject({ revision: REV_A });
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
