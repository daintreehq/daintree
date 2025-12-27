export interface NoteMetadata {
  id: string;
  title: string;
  scope: "worktree" | "project";
  worktreeId?: string;
  createdAt: number;
}

export interface NoteContent {
  metadata: NoteMetadata;
  content: string;
  path: string;
  lastModified: number;
}

export interface NoteListItem {
  id: string;
  title: string;
  path: string;
  scope: "worktree" | "project";
  worktreeId?: string;
  createdAt: number;
  modifiedAt: number;
  preview: string;
}

export interface SearchResult {
  notes: NoteListItem[];
  query: string;
}

export interface NoteUpdatedPayload {
  notePath: string;
  title: string;
  action: "created" | "updated" | "deleted";
}

export interface WriteResult {
  lastModified?: number;
  error?: "conflict";
  message?: string;
  currentLastModified?: number;
}

export const notesClient = {
  create: (
    title: string,
    scope: "worktree" | "project",
    worktreeId?: string
  ): Promise<NoteContent> => {
    return window.electron.notes.create(title, scope, worktreeId);
  },

  read: (notePath: string): Promise<NoteContent> => {
    return window.electron.notes.read(notePath);
  },

  write: (
    notePath: string,
    content: string,
    metadata: NoteMetadata,
    expectedLastModified?: number
  ): Promise<WriteResult> => {
    return window.electron.notes.write(notePath, content, metadata, expectedLastModified);
  },

  list: (): Promise<NoteListItem[]> => {
    return window.electron.notes.list();
  },

  delete: (notePath: string): Promise<void> => {
    return window.electron.notes.delete(notePath);
  },

  search: (query: string): Promise<SearchResult> => {
    return window.electron.notes.search(query);
  },

  onUpdated: (callback: (payload: NoteUpdatedPayload) => void): (() => void) => {
    return window.electron.notes.onUpdated(callback);
  },
} as const;
