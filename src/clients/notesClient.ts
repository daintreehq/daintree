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
}

export interface NoteListItem {
  id: string;
  title: string;
  path: string;
  scope: "worktree" | "project";
  worktreeId?: string;
  createdAt: number;
  modifiedAt: number;
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

  write: (notePath: string, content: string, metadata: NoteMetadata): Promise<void> => {
    return window.electron.notes.write(notePath, content, metadata);
  },

  list: (): Promise<NoteListItem[]> => {
    return window.electron.notes.list();
  },

  delete: (notePath: string): Promise<void> => {
    return window.electron.notes.delete(notePath);
  },
} as const;
