import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import { NotesService, type NoteMetadata } from "../../services/NotesService.js";
import { projectStore } from "../../services/ProjectStore.js";

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

export function registerNotesHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleNotesCreate = async (
    _event: Electron.IpcMainInvokeEvent,
    title: string,
    scope: "worktree" | "project",
    worktreeId?: string
  ) => {
    const service = getNotesService();
    return await service.create(title, scope, worktreeId);
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
    metadata: unknown
  ) => {
    const service = getNotesService();
    const validatedMetadata = validateNoteMetadata(metadata);
    return await service.write(notePath, content, validatedMetadata);
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
    return await service.delete(notePath);
  };
  ipcMain.handle(CHANNELS.NOTES_DELETE, handleNotesDelete);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.NOTES_DELETE));

  return () => {
    handlers.forEach((dispose) => dispose());
  };
}
