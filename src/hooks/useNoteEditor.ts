import { useState, useEffect, useRef, useCallback } from "react";
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

  // Load note content when selected
  useEffect(() => {
    const note = latestSelectedNoteRef.current;
    if (!note) {
      setNoteContent("");
      setNoteMetadata(null);
      setNoteLastModified(null);
      setHasConflict(false);
      return;
    }

    let cancelled = false;
    setIsLoadingContent(true);
    setHasConflict(false);

    notesClient
      .read(note.path)
      .then((content) => {
        if (cancelled) return;
        setNoteContent(content.content);
        setNoteMetadata(content.metadata);
        setNoteLastModified(content.lastModified);
        setIsLoadingContent(false);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load note:", e);
        setIsLoadingContent(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedNote?.id]);

  const handleContentChange = useCallback(
    (value: string) => {
      setNoteContent(value);

      const note = latestSelectedNoteRef.current;
      const metadata = latestMetadataRef.current;
      if (!note || !metadata || latestHasConflictRef.current) return;

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = setTimeout(async () => {
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
        handleRemoveTag(latestMetadataRef.current.tags[latestMetadataRef.current.tags.length - 1]);
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
    tagInput,
    setTagInput,
    handleTagInputKeyDown,
  };
}
