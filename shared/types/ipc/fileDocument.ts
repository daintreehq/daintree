import type { PluginFileDocumentReadResult, PluginFileDocumentSaveResult } from "../plugin.js";

/**
 * The host-owned document behind a view-backed file editor (#13809). Every
 * call names the root the file panel reads through, so main confines the file
 * to it exactly as `files:read` does, plus the editor's byte ceiling.
 */
export interface FileDocumentReadPayload {
  /** Project or worktree root the file panel contains the file in. */
  rootPath: string;
  filePath: string;
  maxBytes: number;
}

export interface FileDocumentSavePayload extends FileDocumentReadPayload {
  /** Editor text, lines joined with `\n`; main re-applies the file's own BOM and line ending. */
  text: string;
  /** The revision the text was based on; the write happens only if the file is still there. */
  expectedRevision: string;
}

export type FileDocumentReadResult = PluginFileDocumentReadResult;

/** `refused: "read-only"` never comes from main — the renderer facade answers it. */
export type FileDocumentSaveResult = PluginFileDocumentSaveResult;
