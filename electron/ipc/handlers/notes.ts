import { app } from "electron";
import { CHANNELS } from "../channels.js";
import { broadcastToRenderer, typedHandleWithContext } from "../utils.js";
import type { HandlerDependencies } from "../types.js";
import type { IpcContext } from "../types.js";
import { NotesService, NoteConflictError, type NoteMetadata } from "../../services/NotesService.js";

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

const notesServices = new Map<string, NotesService>();

function resolveNotesService(ctx: IpcContext): NotesService {
  if (!ctx.projectId) {
    throw new Error("No active project");
  }

  let service = notesServices.get(ctx.projectId);
  if (!service) {
    service = new NotesService(app.getPath("userData"), ctx.projectId);
    notesServices.set(ctx.projectId, service);
  }
  return service;
}

export function _resetNotesServicesForTest(): void {
  notesServices.clear();
}

export function registerNotesHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const broadcastUpdate = (payload: NoteUpdatedPayload) => {
    broadcastToRenderer(CHANNELS.NOTES_UPDATED, payload);
  };

  const handleNotesCreate = async (
    ctx: IpcContext,
    title: string,
    scope: "worktree" | "project",
    worktreeId?: string
  ) => {
    const service = resolveNotesService(ctx);
    const result = await service.create(title, scope, worktreeId);
    broadcastUpdate({ notePath: result.path, title, action: "created" });
    return result;
  };
  handlers.push(typedHandleWithContext(CHANNELS.NOTES_CREATE, handleNotesCreate));

  const handleNotesRead = async (ctx: IpcContext, notePath: string) => {
    const service = resolveNotesService(ctx);
    return await service.read(notePath);
  };
  handlers.push(typedHandleWithContext(CHANNELS.NOTES_READ, handleNotesRead));

  const handleNotesWrite = async (
    ctx: IpcContext,
    notePath: string,
    content: string,
    metadata: unknown,
    expectedLastModified?: number
  ) => {
    const service = resolveNotesService(ctx);
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
      if (!(error instanceof NoteConflictError)) {
        throw error;
      }

      // External modification detected. Preserve the disk version to a sibling
      // file, then force-save the user's buffer to the original path so their
      // unsaved edits are not lost.
      const { conflictPath } = await service.createConflictCopy(notePath);
      broadcastUpdate({
        notePath: conflictPath,
        title: `${validatedMetadata.title} (conflict)`,
        action: "created",
      });

      let result: { lastModified: number };
      try {
        result = await service.write(notePath, content, validatedMetadata);
      } catch (forceErr) {
        // The conflict copy is on disk but the user's buffer failed to save.
        // Annotate the rethrown error with the preserved path so the caller
        // can tell the user their disk version is safe while asking them to
        // retry the save.
        const message = forceErr instanceof Error ? forceErr.message : "Failed to save note";
        const wrapped = new Error(
          `${message} (previous disk version preserved at ${conflictPath})`
        );
        (wrapped as Error & { conflictPath?: string }).conflictPath = conflictPath;
        throw wrapped;
      }
      broadcastUpdate({ notePath, title: validatedMetadata.title, action: "updated" });

      return { ...result, conflictPath };
    }
  };
  handlers.push(typedHandleWithContext(CHANNELS.NOTES_WRITE, handleNotesWrite));

  const handleNotesList = async (ctx: IpcContext) => {
    const service = resolveNotesService(ctx);
    return await service.list();
  };
  handlers.push(typedHandleWithContext(CHANNELS.NOTES_LIST, handleNotesList));

  const handleNotesDelete = async (ctx: IpcContext, notePath: string) => {
    const service = resolveNotesService(ctx);
    await service.delete(notePath);
    broadcastUpdate({ notePath, title: "", action: "deleted" });
  };
  handlers.push(typedHandleWithContext(CHANNELS.NOTES_DELETE, handleNotesDelete));

  const handleNotesSearch = async (ctx: IpcContext, query: string) => {
    const service = resolveNotesService(ctx);
    return await service.search(query);
  };
  handlers.push(typedHandleWithContext(CHANNELS.NOTES_SEARCH, handleNotesSearch));

  const handleNotesWriteAttachment = async (
    ctx: IpcContext,
    data: Uint8Array,
    mimeType: string,
    originalName?: string
  ) => {
    const service = resolveNotesService(ctx);
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return await service.saveAttachment(buffer, mimeType, originalName);
  };
  handlers.push(
    typedHandleWithContext(CHANNELS.NOTES_WRITE_ATTACHMENT, handleNotesWriteAttachment)
  );

  const handleNotesGetDir = async (ctx: IpcContext) => {
    const service = resolveNotesService(ctx);
    return service.getDirPath();
  };
  handlers.push(typedHandleWithContext(CHANNELS.NOTES_GET_DIR, handleNotesGetDir));

  return () => {
    handlers.forEach((dispose) => dispose());
  };
}
