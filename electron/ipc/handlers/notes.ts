import { app } from "electron";
import { CHANNELS } from "../channels.js";
import { broadcastToRenderer, typedHandle } from "../utils.js";
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
  if (
    m.tags !== undefined &&
    (!Array.isArray(m.tags) || !m.tags.every((t: unknown) => typeof t === "string"))
  ) {
    throw new Error("Invalid metadata: tags must be an array of strings if provided");
  }

  return {
    id: m.id,
    title: m.title,
    scope: m.scope,
    worktreeId: m.worktreeId as string | undefined,
    createdAt: m.createdAt,
    ...(m.tags !== undefined && { tags: m.tags as string[] }),
  };
}

let notesService: NotesService | null = null;

function getNotesService(): NotesService {
  const currentProject = projectStore.getCurrentProject();
  if (!currentProject) {
    throw new Error("No active project");
  }

  if (!notesService || notesService.getProjectId() !== currentProject.id) {
    notesService = new NotesService(app.getPath("userData"), currentProject.id);
  }

  return notesService;
}

export function registerNotesHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const broadcastUpdate = (payload: NoteUpdatedPayload) => {
    broadcastToRenderer(CHANNELS.NOTES_UPDATED, payload);
  };

  const handleNotesCreate = async (
    title: string,
    scope: "worktree" | "project",
    worktreeId?: string
  ) => {
    const service = getNotesService();
    const result = await service.create(title, scope, worktreeId);
    broadcastUpdate({ notePath: result.path, title, action: "created" });
    return result;
  };
  handlers.push(typedHandle(CHANNELS.NOTES_CREATE, handleNotesCreate));

  const handleNotesRead = async (notePath: string) => {
    const service = getNotesService();
    return await service.read(notePath);
  };
  handlers.push(typedHandle(CHANNELS.NOTES_READ, handleNotesRead));

  const handleNotesWrite = async (
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
          error: "conflict" as const,
          message: error.message,
          currentLastModified: error.currentLastModified,
        };
      }
      throw error;
    }
  };
  handlers.push(typedHandle(CHANNELS.NOTES_WRITE, handleNotesWrite));

  const handleNotesList = async () => {
    const service = getNotesService();
    return await service.list();
  };
  handlers.push(typedHandle(CHANNELS.NOTES_LIST, handleNotesList));

  const handleNotesDelete = async (notePath: string) => {
    const service = getNotesService();
    await service.delete(notePath);
    broadcastUpdate({ notePath, title: "", action: "deleted" });
  };
  handlers.push(typedHandle(CHANNELS.NOTES_DELETE, handleNotesDelete));

  const handleNotesSearch = async (query: string) => {
    const service = getNotesService();
    return await service.search(query);
  };
  handlers.push(typedHandle(CHANNELS.NOTES_SEARCH, handleNotesSearch));

  const handleNotesWriteAttachment = async (
    data: Uint8Array,
    mimeType: string,
    originalName?: string
  ) => {
    const service = getNotesService();
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return await service.saveAttachment(buffer, mimeType, originalName);
  };
  handlers.push(typedHandle(CHANNELS.NOTES_WRITE_ATTACHMENT, handleNotesWriteAttachment));

  const handleNotesGetDir = async () => {
    const service = getNotesService();
    return service.getDirPath();
  };
  handlers.push(typedHandle(CHANNELS.NOTES_GET_DIR, handleNotesGetDir));

  return () => {
    handlers.forEach((dispose) => dispose());
  };
}
