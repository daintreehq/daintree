import { useState, useEffect, useEffectEvent, useRef, useCallback } from "react";
import { notesClient, type NoteListItem, type NoteMetadata } from "@/clients/notesClient";
import { normalizeTag } from "../../shared/utils/noteTags";

interface UseNoteEditorOptions {
  selectedNote: NoteListItem | null;
  refresh: () => void;
  setLastSelectedNoteId: (id: string | null) => void;
}

export interface UseNoteEditorReturn {
  noteContent: string;
  setNoteContent: (content: string) => void;
  noteMetadata: NoteMetadata | null;
  setNoteMetadata: (metadata: NoteMetadata | null) => void;
  noteLastModified: number | null;
  setNoteLastModified: (ts: number | null) => void;
  isLoadingContent: boolean;
  /**
   * When set, a previous save preserved the external on-disk version at this
   * relative path; the user's buffer continues to save to the original file.
   * Non-null means an unacknowledged conflict banner is showing.
   */
  conflictCopyPath: string | null;
  dismissConflictNotice: () => void;
  handleContentChange: (value: string) => void;
  handleAddTag: (tag: string) => Promise<void>;
  handleRemoveTag: (tag: string) => Promise<void>;
  flushSave: () => Promise<void>;
  getLatestContent: () => string;
  tagInput: string;
  setTagInput: (v: string) => void;
  handleTagInputKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export function useNoteEditor({
  selectedNote,
  refresh,
  setLastSelectedNoteId,
}: UseNoteEditorOptions): UseNoteEditorReturn {
  const [noteContent, setNoteContent] = useState("");
  const [noteMetadata, setNoteMetadata] = useState<NoteMetadata | null>(null);
  const [noteLastModified, setNoteLastModified] = useState<number | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [conflictCopyPath, setConflictCopyPath] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const latestContentRef = useRef(noteContent);
  const latestMetadataRef = useRef(noteMetadata);
  const latestLastModifiedRef = useRef(noteLastModified);
  const latestSelectedNoteRef = useRef(selectedNote);

  // Keep refs in sync after commit
  useEffect(() => {
    latestContentRef.current = noteContent;
    latestMetadataRef.current = noteMetadata;
    latestLastModifiedRef.current = noteLastModified;
    latestSelectedNoteRef.current = selectedNote;
  });

  // Flush-on-switch: when selectedNote changes, save pending content immediately
  // Capture note path at setup time to avoid stale ref during cleanup
  const selectedNotePath = selectedNote?.path ?? null;
  useEffect(() => {
    const notePath = selectedNotePath;
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;

        const content = latestContentRef.current;
        const metadata = latestMetadataRef.current;
        const lastMod = latestLastModifiedRef.current;

        if (notePath && metadata) {
          notesClient
            .write(notePath, content, metadata, lastMod ?? undefined)
            .catch((e) => console.error("Failed to flush save:", e));
        }
      }
    };
  }, [selectedNotePath]);

  // Load note content when selected. selectedNote is captured by useEffectEvent
  // for concurrent-mode safety; the effect re-runs only when id changes.
  const loadNoteContent = useEffectEvent((token: { cancelled: boolean }) => {
    const note = selectedNote;
    if (!note) {
      setNoteContent("");
      setNoteMetadata(null);
      setNoteLastModified(null);
      setConflictCopyPath(null);
      return;
    }

    setNoteContent("");
    setNoteMetadata(null);
    setNoteLastModified(null);
    setIsLoadingContent(true);
    setConflictCopyPath(null);

    notesClient
      .read(note.path)
      .then((content) => {
        if (token.cancelled) return;
        setNoteContent(content.content);
        setNoteMetadata(content.metadata);
        setNoteLastModified(content.lastModified);
        setIsLoadingContent(false);
      })
      .catch((e) => {
        if (token.cancelled) return;
        console.error("Failed to load note:", e);
        setIsLoadingContent(false);
      });
  });

  useEffect(() => {
    const token = { cancelled: false };
    loadNoteContent(token);
    return () => {
      token.cancelled = true;
    };
  }, [selectedNote?.id]);

  const applyWriteResult = useCallback(
    (result: { lastModified?: number; conflictPath?: string }, noteId: string) => {
      if (result.lastModified) {
        setNoteLastModified(result.lastModified);
        if (latestContentRef.current.trim()) {
          setLastSelectedNoteId(noteId);
        }
      }
      if (result.conflictPath) {
        setConflictCopyPath(result.conflictPath);
      }
    },
    [setLastSelectedNoteId]
  );

  const handleContentChange = useCallback(
    (value: string) => {
      setNoteContent(value);
      latestContentRef.current = value;

      const note = latestSelectedNoteRef.current;
      const metadata = latestMetadataRef.current;
      if (!note || !metadata) return;

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = setTimeout(async () => {
        saveTimeoutRef.current = null;
        try {
          const result = await notesClient.write(
            note.path,
            latestContentRef.current,
            latestMetadataRef.current!,
            latestLastModifiedRef.current ?? undefined
          );
          // Drop late writes whose note has been deselected/switched; the new
          // note owns the editor state now.
          if (latestSelectedNoteRef.current?.id !== note.id) return;
          applyWriteResult(result, note.id);
        } catch (e) {
          console.error("Failed to save note:", e);
        }
      }, 500);
    },
    [applyWriteResult]
  );

  const flushSave = useCallback(async () => {
    if (!saveTimeoutRef.current) return;
    clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = null;

    const note = latestSelectedNoteRef.current;
    const metadata = latestMetadataRef.current;
    if (!note || !metadata) return;

    try {
      const result = await notesClient.write(
        note.path,
        latestContentRef.current,
        metadata,
        latestLastModifiedRef.current ?? undefined
      );
      applyWriteResult(result, note.id);
    } catch (e) {
      console.error("Failed to flush save:", e);
    }
  }, [applyWriteResult]);

  const getLatestContent = useCallback(() => {
    return latestContentRef.current;
  }, []);

  const dismissConflictNotice = useCallback(() => {
    setConflictCopyPath(null);
  }, []);

  const handleAddTag = useCallback(
    async (tag: string) => {
      const note = latestSelectedNoteRef.current;
      const metadata = latestMetadataRef.current;
      if (!note || !metadata) return;

      const normalized = normalizeTag(tag);
      if (!normalized) return;
      const currentTags = metadata.tags ?? [];
      if (currentTags.includes(normalized)) return;

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }

      const updatedTags = [...currentTags, normalized];
      const updatedMetadata = { ...metadata, tags: updatedTags };
      setNoteMetadata(updatedMetadata);

      try {
        const result = await notesClient.write(
          note.path,
          latestContentRef.current,
          updatedMetadata,
          latestLastModifiedRef.current ?? undefined
        );
        if (result.lastModified) {
          setNoteLastModified(result.lastModified);
        }
        if (result.conflictPath) {
          setConflictCopyPath(result.conflictPath);
        }
        await refresh();
      } catch (e) {
        console.error("Failed to save tags:", e);
      }
    },
    [refresh]
  );

  const handleRemoveTag = useCallback(
    async (tag: string) => {
      const note = latestSelectedNoteRef.current;
      const metadata = latestMetadataRef.current;
      if (!note || !metadata) return;

      const currentTags = metadata.tags ?? [];
      const updatedTags = currentTags.filter((t) => t !== tag);
      const updatedMetadata = {
        ...metadata,
        tags: updatedTags.length > 0 ? updatedTags : undefined,
      };

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }

      setNoteMetadata(updatedMetadata);

      try {
        const result = await notesClient.write(
          note.path,
          latestContentRef.current,
          updatedMetadata,
          latestLastModifiedRef.current ?? undefined
        );
        if (result.lastModified) {
          setNoteLastModified(result.lastModified);
        }
        if (result.conflictPath) {
          setConflictCopyPath(result.conflictPath);
        }
        await refresh();
      } catch (e) {
        console.error("Failed to save tags:", e);
      }
    },
    [refresh]
  );

  const handleTagInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        handleAddTag(tagInput);
        setTagInput("");
      } else if (e.key === "Backspace" && !tagInput && latestMetadataRef.current?.tags?.length) {
        handleRemoveTag(latestMetadataRef.current.tags[latestMetadataRef.current.tags.length - 1]!);
      }
    },
    [tagInput, handleAddTag, handleRemoveTag]
  );

  return {
    noteContent,
    setNoteContent,
    noteMetadata,
    setNoteMetadata,
    noteLastModified,
    setNoteLastModified,
    isLoadingContent,
    conflictCopyPath,
    dismissConflictNotice,
    handleContentChange,
    handleAddTag,
    handleRemoveTag,
    flushSave,
    getLatestContent,
    tagInput,
    setTagInput,
    handleTagInputKeyDown,
  };
}
