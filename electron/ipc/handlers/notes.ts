import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import { NotesService, NoteConflictError, type NoteMetadata } from "../../services/NotesService.js";
import { projectStore } from "../../services/ProjectStore.js";

export interface NoteUpdatedPayload {
  notePath: string;
  title: string;
  action: "created" | "updated" | "deleted";
}

function validateNoteMetadata(metadata: unknown): NoteMetadata {
  if (typeof metadata !== "object" || metadata === null) {
    throw new Error("Invalid metadata: must be an object");
  }

  const m = metadata as Record<string, unknown>;

  if (typeof m.id !== "string" || m.id.length === 0) {
    throw new Error("Invalid metadata: id must be a non-empty string");
  }
  if (typeof m.title !== "string") {
    throw new Error("Invalid metadata: title must be a string");
  }
  if (m.scope !== "worktree" && m.scope !== "project") {
    throw new Error("Invalid metadata: scope must be 'worktree' or 'project'");
  }
  if (m.worktreeId !== undefined && typeof m.worktreeId !== "string") {
    throw new Error("Invalid metadata: worktreeId must be a string if provided");
  }
  if (typeof m.createdAt !== "number") {
    throw new Error("Invalid metadata: createdAt must be a number");
  }

  return {
    id: m.id,
    title: m.title,
    scope: m.scope,
    worktreeId: m.worktreeId as string | undefined,
    createdAt: m.createdAt,
  };
}

let notesService: NotesService | null = null;

function getNotesService(): NotesService {
  const currentProject = projectStore.getCurrentProject();
  if (!currentProject) {
    throw new Error("No active project");
  }

  if (!notesService || notesService["projectPath"] !== currentProject.path) {
    notesService = new NotesService(currentProject.path);
  }

  return notesService;
}

export function registerNotesHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const broadcastUpdate = (payload: NoteUpdatedPayload) => {
    deps.mainWindow.webContents.send(CHANNELS.NOTES_UPDATED, payload);
  };

  const handleNotesCreate = async (
    _event: Electron.IpcMainInvokeEvent,
    title: string,
    scope: "worktree" | "project",
    worktreeId?: string
  ) => {
    const service = getNotesService();
    const result = await service.create(title, scope, worktreeId);
    broadcastUpdate({ notePath: result.path, title, action: "created" });
    return result;
  };
  ipcMain.handle(CHANNELS.NOTES_CREATE, handleNotesCreate);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.NOTES_CREATE));

  const handleNotesRead = async (_event: Electron.IpcMainInvokeEvent, notePath: string) => {
    const service = getNotesService();
    return await service.read(notePath);
  };
  ipcMain.handle(CHANNELS.NOTES_READ, handleNotesRead);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.NOTES_READ));

  const handleNotesWrite = async (
    _event: Electron.IpcMainInvokeEvent,
    notePath: string,
    content: string,
    metadata: unknown,
    expectedLastModified?: number
  ) => {
    const service = getNotesService();
    const validatedMetadata = validateNoteMetadata(metadata);
    try {
      const result = await service.write(
        notePath,
        content,
        validatedMetadata,
        expectedLastModified
      );
      broadcastUpdate({ notePath, title: validatedMetadata.title, action: "updated" });
      return result;
    } catch (error) {
      if (error instanceof NoteConflictError) {
        return {
          error: "conflict",
          message: error.message,
          currentLastModified: error.currentLastModified,
        };
      }
      throw error;
    }
  };
  ipcMain.handle(CHANNELS.NOTES_WRITE, handleNotesWrite);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.NOTES_WRITE));

  const handleNotesList = async (_event: Electron.IpcMainInvokeEvent) => {
    const service = getNotesService();
    return await service.list();
  };
  ipcMain.handle(CHANNELS.NOTES_LIST, handleNotesList);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.NOTES_LIST));

  const handleNotesDelete = async (_event: Electron.IpcMainInvokeEvent, notePath: string) => {
    const service = getNotesService();
    await service.delete(notePath);
    broadcastUpdate({ notePath, title: "", action: "deleted" });
  };
  ipcMain.handle(CHANNELS.NOTES_DELETE, handleNotesDelete);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.NOTES_DELETE));

  const handleNotesSearch = async (_event: Electron.IpcMainInvokeEvent, query: string) => {
    const service = getNotesService();
    return await service.search(query);
  };
  ipcMain.handle(CHANNELS.NOTES_SEARCH, handleNotesSearch);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.NOTES_SEARCH));

  return () => {
    handlers.forEach((dispose) => dispose());
  };
}
