import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionDefinition } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const notesClientMock = vi.hoisted(() => ({
  create: vi.fn(),
  write: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  delete: vi.fn(),
}));

const addPanelMock = vi.hoisted(() => vi.fn());

vi.mock("@/clients/notesClient", () => ({ notesClient: notesClientMock }));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ addPanel: addPanelMock }) },
}));

import { registerNotesActions } from "../notesActions";

function setupActions() {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {} as unknown as ActionCallbacks;
  registerNotesActions(actions, callbacks);
  return async (id: string, args?: unknown): Promise<unknown> => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def = factory() as ActionDefinition<unknown, unknown>;
    return def.run(args, {} as never);
  };
}

const dispatchSpy = vi.fn<(event: Event) => boolean>(() => true);
const confirmSpy = vi.fn<(msg: string) => boolean>();
const alertSpy = vi.fn<(msg: string) => void>();

beforeEach(() => {
  vi.clearAllMocks();
  dispatchSpy.mockReset().mockReturnValue(true);
  confirmSpy.mockReset().mockReturnValue(true);
  alertSpy.mockReset();
  Object.defineProperty(globalThis, "window", {
    value: {
      dispatchEvent: dispatchSpy,
      confirm: confirmSpy,
      alert: alertSpy,
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
});

describe("notesActions adversarial", () => {
  it("notes.create with worktree scope but no worktreeId should reject before touching the client", async () => {
    const run = setupActions();

    await expect(run("notes.create", { title: "t", scope: "worktree" })).rejects.toThrow(
      /worktreeId/i
    );

    expect(notesClientMock.create).not.toHaveBeenCalled();
  });

  it("notes.create with empty title opens the palette (no client call)", async () => {
    const run = setupActions();
    await run("notes.create", {});

    expect(notesClientMock.create).not.toHaveBeenCalled();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const event = dispatchSpy.mock.calls[0]![0] as unknown as { type: string };
    expect(event.type).toBe("daintree:open-notes-palette");
  });

  it("notes.create with title + content writes content after creating", async () => {
    notesClientMock.create.mockResolvedValue({
      path: "/notes/a.md",
      metadata: { id: "n1", title: "t", createdAt: 1 },
    });
    notesClientMock.write.mockResolvedValue(undefined);

    const run = setupActions();
    const result = (await run("notes.create", {
      title: "t",
      content: "hello",
    })) as { path: string; title: string; id: string };

    expect(notesClientMock.create).toHaveBeenCalledWith("t", "project", undefined);
    expect(notesClientMock.write).toHaveBeenCalledWith("/notes/a.md", "hello", {
      id: "n1",
      title: "t",
      createdAt: 1,
    });
    expect(result).toEqual({ path: "/notes/a.md", title: "t", id: "n1" });
  });

  it("notes.create: when write fails, openPanel is never called", async () => {
    notesClientMock.create.mockResolvedValue({
      path: "/notes/a.md",
      metadata: { id: "n1", title: "t", createdAt: 1 },
    });
    notesClientMock.write.mockRejectedValue(new Error("disk full"));

    const run = setupActions();
    await expect(
      run("notes.create", { title: "t", content: "hi", openPanel: true })
    ).rejects.toThrow("disk full");

    expect(addPanelMock).not.toHaveBeenCalled();
  });

  it("notes.create with openPanel:true passes note metadata to addPanel", async () => {
    notesClientMock.create.mockResolvedValue({
      path: "/notes/b.md",
      metadata: { id: "n2", title: "Title", createdAt: 123 },
    });

    const run = setupActions();
    await run("notes.create", {
      title: "Title",
      openPanel: true,
      scope: "project",
    });

    expect(addPanelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "notes",
        title: "Title",
        notePath: "/notes/b.md",
        noteId: "n2",
        scope: "project",
        createdAt: 123,
        location: "grid",
      })
    );
  });

  it("notes.delete cancelled by user returns { cancelled: true } and does not call client", async () => {
    confirmSpy.mockReturnValue(false);
    const run = setupActions();

    const result = await run("notes.delete", {
      notePath: "/notes/a.md",
      noteTitle: "T",
    });

    expect(result).toEqual({ cancelled: true });
    expect(notesClientMock.delete).not.toHaveBeenCalled();
  });

  it("notes.delete treats ENOENT as idempotent success, no alert", async () => {
    notesClientMock.delete.mockRejectedValue(
      Object.assign(new Error("not found"), { code: "ENOENT" })
    );
    const run = setupActions();

    const result = await run("notes.delete", {
      notePath: "/notes/gone.md",
    });

    expect(result).toEqual({ success: true });
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("notes.delete non-ENOENT shows alert and rethrows with the error message", async () => {
    notesClientMock.delete.mockRejectedValue(
      Object.assign(new Error("permission denied"), { code: "EACCES" })
    );
    const run = setupActions();

    await expect(
      run("notes.delete", { notePath: "/notes/locked.md", noteTitle: "Locked" })
    ).rejects.toThrow("permission denied");

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0]![0]).toContain("permission denied");
  });

  it("notes.reveal dispatches highlight event with the note path", async () => {
    const run = setupActions();
    await run("notes.reveal", { notePath: "/notes/x.md" });

    const event = dispatchSpy.mock.calls[0]![0] as unknown as {
      type: string;
      detail: { highlightNotePath: string };
    };
    expect(event.type).toBe("daintree:open-notes-palette");
    expect(event.detail.highlightNotePath).toBe("/notes/x.md");
  });

  it("notes.list forwards directly to the client", async () => {
    notesClientMock.list.mockResolvedValue([{ path: "/a.md" }]);
    const run = setupActions();
    expect(await run("notes.list")).toEqual([{ path: "/a.md" }]);
  });
});
