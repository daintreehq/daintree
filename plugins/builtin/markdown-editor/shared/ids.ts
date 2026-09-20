/**
 * The zod-free half of the Markdown editor's contract: ids, channel names and
 * the pure helpers over them. Split out of `protocol.ts` because the renderer
 * entry is globbed eagerly into the host bundle for every user (#12323), and
 * importing anything from `protocol.ts` would drag zod into that first-render
 * graph. `protocol.ts` re-exports everything here, so the main side and every
 * other importer keep their single import site.
 */
export const PLUGIN_ID = "daintree.markdown-editor";
export const EDITOR_SLOT = "markdown.editor";
export const EDITOR_CONTRIBUTION_ID = "markdown";

/** Lower-case extensions the editor accepts. MDX is deliberately absent. */
export const EDITABLE_EXTENSIONS = ["md", "markdown", "mkd"] as const;
/** Byte ceiling applied at open, to draft growth and at the write boundary. */
export const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;

export const DRAFT_RECORD_LIMIT = 50;
export const DRAFT_STORAGE_LIMIT_BYTES = 16 * 1024 * 1024;

export const CHANNELS = {
  read: "document.read",
  attach: "document.attach",
  save: "document.save",
  saveAs: "document.saveAs",
  revalidate: "document.revalidate",
  release: "document.release",
  draftPut: "drafts.put",
  draftGet: "drafts.get",
  draftList: "drafts.list",
  draftDelete: "drafts.delete",
  recoverAck: "recover.ack",
} as const;

/** Main → renderer pushes, subscribed with `window.electron.plugin.on`. */
export const PUSH_CHANNELS = {
  documentChanged: "document-changed",
  recoverDraft: "recover-draft",
} as const;

export const RECOVER_DRAFTS_ACTION_ID = "recover-drafts";

/**
 * Hand-written rather than inferred, so this module stays zod-free.
 * `protocol.ts` asserts at compile time that `DocumentIdentitySchema` still
 * produces exactly this shape.
 */
export type DocumentIdentity = {
  projectId: string;
  worktreePath: string | null;
  filePath: string;
};

/** One opaque key per identity; the recovery file name is its sha256. */
export function identityKey(identity: DocumentIdentity): string {
  return `${identity.projectId}\u0000${identity.worktreePath ?? ""}\u0000${identity.filePath}`;
}

export function isEditableFilePath(filePath: string): boolean {
  const name = filePath.split(/[/\\]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  return (EDITABLE_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1).toLowerCase());
}

export interface DocumentChangedPush {
  identityKey: string;
}

export interface RecoverDraftPush {
  requestId: string;
  identity: DocumentIdentity;
}
