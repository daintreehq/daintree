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
  hasConflict: boolean;
  setHasConflict: (v: boolean) => void;
  handleContentChange: (value: string) => void;
  handleAddTag: (tag: string) => Promise<void>;
  handleRemoveTag: (tag: string) => Promise<void>;
  handleReloadNote: () => Promise<void>;
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
  const [hasConflict, setHasConflict] = useState(false);
  const [tagInput, setTagInput] = useState("");

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const latestContentRef = useRef(noteContent);
  const latestMetadataRef = useRef(noteMetadata);
  const latestLastModifiedRef = useRef(noteLastModified);
  const latestHasConflictRef = useRef(hasConflict);
  const latestSelectedNoteRef = useRef(selectedNote);

  // Keep refs in sync
  latestContentRef.current = noteContent;
  latestMetadataRef.current = noteMetadata;
  latestLastModifiedRef.current = noteLastModified;
  latestHasConflictRef.current = hasConflict;
  latestSelectedNoteRef.current = selectedNote;

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
        const conflict = latestHasConflictRef.current;

        if (notePath && metadata && !conflict) {
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
      setHasConflict(false);
      return;
    }

    setNoteContent("");
    setNoteMetadata(null);
    setNoteLastModified(null);
    setIsLoadingContent(true);
    setHasConflict(false);

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

  const handleContentChange = useCallback(
    (value: string) => {
      setNoteContent(value);
      latestContentRef.current = value;

      const note = latestSelectedNoteRef.current;
      const metadata = latestMetadataRef.current;
      if (!note || !metadata || latestHasConflictRef.current) return;

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

          if (result.error === "conflict") {
            setHasConflict(true);
          } else if (result.lastModified) {
            setNoteLastModified(result.lastModified);
            if (latestContentRef.current.trim()) {
              setLastSelectedNoteId(note.id);
            }
          }
        } catch (e) {
          console.error("Failed to save note:", e);
        }
      }, 500);
    },
    [setLastSelectedNoteId]
  );

  const flushSave = useCallback(async () => {
    if (!saveTimeoutRef.current) return;
    clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = null;

    const note = latestSelectedNoteRef.current;
    const metadata = latestMetadataRef.current;
    if (!note || !metadata || latestHasConflictRef.current) return;

    try {
      const result = await notesClient.write(
        note.path,
        latestContentRef.current,
        metadata,
        latestLastModifiedRef.current ?? undefined
      );
      if (result.error === "conflict") {
        setHasConflict(true);
      } else if (result.lastModified) {
        setNoteLastModified(result.lastModified);
        if (latestContentRef.current.trim()) {
          setLastSelectedNoteId(note.id);
        }
      }
    } catch (e) {
      console.error("Failed to flush save:", e);
    }
  }, [setLastSelectedNoteId]);

  const getLatestContent = useCallback(() => {
    return latestContentRef.current;
  }, []);

  const handleReloadNote = useCallback(async () => {
    const note = latestSelectedNoteRef.current;
    if (!note) return;
    setHasConflict(false);
    setIsLoadingContent(true);
    try {
      const content = await notesClient.read(note.path);
      setNoteContent(content.content);
      setNoteMetadata(content.metadata);
      setNoteLastModified(content.lastModified);
    } catch (e) {
      console.error("Failed to reload note:", e);
    } finally {
      setIsLoadingContent(false);
    }
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
        if (result.error === "conflict") {
          setHasConflict(true);
        } else if (result.lastModified) {
          setNoteLastModified(result.lastModified);
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
        if (result.error === "conflict") {
          setHasConflict(true);
        } else if (result.lastModified) {
          setNoteLastModified(result.lastModified);
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
    hasConflict,
    setHasConflict,
    handleContentChange,
    handleAddTag,
    handleRemoveTag,
    handleReloadNote,
    flushSave,
    getLatestContent,
    tagInput,
    setTagInput,
    handleTagInputKeyDown,
  };
}
