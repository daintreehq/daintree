import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { AlertTriangle, EyeOff, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KbdChord } from "@/components/ui/Kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Textarea } from "@/components/ui/textarea";
import { comboToAriaKeyshortcuts } from "@/lib/kbdShortcut";
import { isMac } from "@/lib/platform";
import { notify } from "@/lib/notify";
import { armTooltipFocusSuppression } from "@/lib/tooltipFocusSuppression";
import { UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";
import { useShallow } from "zustand/react/shallow";
import { selectDiffNotes, useDiffNotesStore } from "@/store/diffNotesStore";
import {
  formatDiffNoteLines,
  sortDiffNotes,
  type DiffNote,
  type DiffNoteAnchor,
  type DiffNoteLines,
} from "./diffNotes";
import {
  DiffNoteDraftContext,
  diffNoteFileKey,
  editDraftBodyKey,
  fileDraftBodyKey,
  lineDraftBodyKey,
  useDiffNoteDraftSession,
  useDiffNoteDraftState,
  type DiffNoteDraftSession,
} from "./diffNoteDrafts";

const SAVE_SHORTCUT = "Cmd+Enter";

/**
 * Held at the icon buttons' height whether or not they're showing, so opening
 * the editor (which drops them) doesn't pull the card up under the cursor, and
 * a composer lines up with the card beside it.
 */
const NOTE_HEADER_CLASS = "mb-1 flex min-h-6 items-center gap-2 text-xs text-text-secondary";

/** How an editor was closed, which decides whether the control focus returns to is ringed. */
export type DiffNoteCloseVia = "keyboard" | "pointer";

function closedVia(event: ReactMouseEvent): DiffNoteCloseVia {
  // A keyboard press on a button arrives as a synthetic click with no detail.
  return event.detail > 0 ? "pointer" : "keyboard";
}

/**
 * Puts focus back on the control the editor replaced, so a keyboard reviewer
 * carries on from the note instead of from the top of the document. Its tooltip
 * stays shut: the caption is for someone arriving at the button, not leaving it.
 */
export function returnFocusTo(target: HTMLElement | null, via: DiffNoteCloseVia): void {
  if (!target?.isConnected) return;
  armTooltipFocusSuppression();
  target.focus({ preventScroll: true, focusVisible: via === "keyboard" });
}

interface DiffNoteEditorProps {
  session: DiffNoteDraftSession;
  /** Where the session keeps this editor's unsaved text. */
  bodyKey: string;
  /** The text to start from when the session has none kept. */
  initialBody: string;
  /** The view whose gestures this editor answers; none for one that opens nothing. */
  focusOwner?: object;
  label: string;
  saveLabel: string;
  onSave: (body: string, via: DiffNoteCloseVia) => void;
  onCancel: (via: DiffNoteCloseVia) => void;
}

/**
 * Typed text lives in the pane's draft session, not the notes store: the store
 * is persisted and shared across project views, and every keystroke there would
 * reserialize it — and would rebuild the diff's widget map under the caret.
 */
function DiffNoteEditor({
  session,
  bodyKey,
  initialBody,
  focusOwner,
  label,
  saveLabel,
  onSave,
  onCancel,
}: DiffNoteEditorProps) {
  const [body, setBody] = useState(() => session.readBody(bodyKey) ?? initialBody);
  const canSave = body.trim().length > 0;
  const hintId = useId();

  // Takes focus only when a gesture asked for this editor; one restored by a
  // refresh or a layout switch stays out of the way. In a layout effect, as
  // `autoFocus` would be, so the caret is in place before the first paint.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const focusWanted = useDiffNoteDraftState(
    session,
    (state) =>
      focusOwner !== undefined && state.focus?.key === bodyKey && state.focus.owner === focusOwner
  );
  useLayoutEffect(() => {
    if (!focusWanted) return;
    textareaRef.current?.focus();
    session.consumeFocus(bodyKey);
  }, [focusWanted, session, bodyKey]);

  // On the editor rather than the textarea, so the keys still work once Tab has
  // moved on to Cancel or Save. A keystroke committing an IME composition is the
  // input method's, not ours (229: browsers that clear `isComposing` first).
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel("keyboard");
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (canSave) onSave(body, "keyboard");
    }
  };

  return (
    <div className="flex flex-col gap-3" onKeyDown={handleKeyDown}>
      <Textarea
        ref={textareaRef}
        aria-label={label}
        density="compact"
        rows={3}
        value={body}
        placeholder="Leave a note for the agent"
        onChange={(event) => {
          setBody(event.target.value);
          session.writeBody(bodyKey, event.target.value);
        }}
        aria-describedby={hintId}
      />
      {/* Two groups that wrap whole, so a narrow column drops the hint onto
          its own line rather than squeezing the buttons. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          id={hintId}
          className="mr-auto inline-flex items-center gap-1.5 text-xs text-text-secondary"
        >
          <KbdChord shortcut={SAVE_SHORTCUT} density="compact" />
          to {saveLabel.toLowerCase()}
          <span className="sr-only">, Escape to cancel</span>
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={(event) => onCancel(closedVia(event))}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="contrast"
            size="xs"
            disabled={!canSave}
            aria-keyshortcuts={comboToAriaKeyshortcuts(SAVE_SHORTCUT, isMac())}
            onClick={(event) => onSave(body, closedVia(event))}
          >
            {saveLabel}
          </Button>
        </span>
      </div>
    </div>
  );
}

export function describeAnchor(anchor: { kind: "file" } | DiffNoteLines): string {
  if (anchor.kind === "file") return "File note";
  // The agent's copy keeps a plain hyphen; on screen a range reads as one.
  const lines = formatDiffNoteLines(anchor).replace("-", "–");
  return anchor.startLine === anchor.endLine ? `Line ${lines}` : `Lines ${lines}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "file note" or "note on line 12", for accessible names built around it. */
export function nameAnchor(anchor: { kind: "file" } | DiffNoteLines): string {
  const described = describeAnchor(anchor);
  return anchor.kind === "file" ? "file note" : `note on ${described.toLowerCase()}`;
}

interface DiffNoteComposerProps {
  worktreePath: string;
  filePath: string;
  anchor: DiffNoteAnchor;
  /** Set when a line draft can't sit under its rows, and why. */
  placement?: DiffNoteCardPlacement;
  /** The view that opens this draft, whose gestures hand its editor focus. */
  focusOwner?: object;
  /** Called after the session has closed the draft, saved or not. */
  onDone: (via: DiffNoteCloseVia) => void;
}

/**
 * A new note being written. A file holds one line draft and one file draft at
 * once, each with its own text, so opening one never takes over the other.
 * Shift-click moves the line draft's widget to a new row, which remounts the
 * composer, so its text lives in the pane's draft session rather than here.
 */
export const DiffNoteComposer = memo(function DiffNoteComposer({
  worktreePath,
  filePath,
  anchor,
  placement,
  focusOwner,
  onDone,
}: DiffNoteComposerProps) {
  const addNote = useDiffNotesStore((s) => s.addNote);
  const session = useDiffNoteDraftSession();
  const fileKey = diffNoteFileKey(worktreePath, filePath);
  const bodyKey = anchor.kind === "file" ? fileDraftBodyKey(fileKey) : lineDraftBodyKey(fileKey);
  const close = (via: DiffNoteCloseVia) => {
    if (anchor.kind === "file") session.closeFile(fileKey);
    else session.closeLine(fileKey);
    onDone(via);
  };
  return (
    <div className="diff-note" data-testid="diff-note-composer">
      <div className={NOTE_HEADER_CLASS}>
        <span>{describeAnchor(anchor)}</span>
        {placement && <DiffNoteStatus placement={placement} anchor={anchor} draft />}
        {/* Said here because this is the only time the gesture does anything:
            shift-click extends an open draft, and there is none before this. */}
        {anchor.kind === "lines" && !placement && (
          <span className="ml-auto text-right">Shift-click another line number to extend</span>
        )}
      </div>
      {/* Keyed by the draft it edits: a list or file view that stays mounted
          while it moves to another file must not carry this file's text there. */}
      <DiffNoteEditor
        key={bodyKey}
        session={session}
        bodyKey={bodyKey}
        initialBody=""
        focusOwner={focusOwner}
        label={`New ${nameAnchor(anchor)}`}
        saveLabel="Add note"
        onSave={(body, via) => {
          addNote({ worktreePath, filePath, anchor, body });
          close(via);
        }}
        onCancel={close}
      />
    </div>
  );
});

/**
 * Where focus goes when a card's Delete takes the focused button away with it:
 * the next note's Edit, else the nearest one before it, else a control naming
 * the same file — the diff's Add file note, or for the fallback list (which has
 * no file header) the pane's path pill — so the review carries on from there.
 */
function deleteFocusSuccessor(card: HTMLElement | null): HTMLElement | null {
  const scope = card?.closest<HTMLElement>("[data-diff-file], .diff-note-list");
  if (!card || !scope) return null;
  const cards = Array.from(scope.querySelectorAll<HTMLElement>("[data-note-card]"));
  const at = cards.indexOf(card);
  for (const other of [...cards.slice(at + 1), ...cards.slice(0, at).reverse()]) {
    const edit = other.querySelector<HTMLElement>("[data-note-edit]");
    if (edit) return edit;
  }
  return (
    scope.querySelector<HTMLElement>("[data-note-file-add]") ??
    card.closest("[data-panel-id]")?.querySelector<HTMLElement>("[data-toolbar-path]") ??
    null
  );
}

/**
 * Why a line note sits above the table instead of under its lines: `stale`
 * means those rows now read differently; `unplaced` means they aren't rendered,
 * so nothing says either way.
 */
export type DiffNoteCardPlacement = "stale" | "unplaced" | undefined;

interface DiffNoteCardProps {
  note: DiffNote;
  placement?: DiffNoteCardPlacement;
}

/** Why the note isn't under its lines, said about those lines. */
function explainPlacement(
  placement: Exclude<DiffNoteCardPlacement, undefined>,
  anchor: DiffNoteAnchor,
  draft: boolean
): string {
  const lines = describeAnchor(anchor);
  const many = anchor.kind === "lines" && anchor.startLine !== anchor.endLine;
  if (draft) {
    return placement === "stale"
      ? `${lines} changed after this note was started, so it's listed here. Check it still applies before adding it.`
      : `${lines} ${many ? "aren't" : "isn't"} shown in this view, so the unsaved note is listed here.`;
  }
  return placement === "stale"
    ? `${lines} changed after this note was written, so it's listed here. Check it still applies before sending.`
    : `${lines} ${many ? "aren't" : "isn't"} shown in this view, so the note is listed here.`;
}

function DiffNoteStatus({
  placement,
  anchor,
  draft = false,
}: {
  placement: Exclude<DiffNoteCardPlacement, undefined>;
  anchor: DiffNoteAnchor;
  draft?: boolean;
}) {
  const stale = placement === "stale";
  const Glyph = stale ? AlertTriangle : EyeOff;
  return (
    // The explanation is the content, so it stays up while the label is
    // hovered or focused rather than timing out mid-sentence.
    <Tooltip autoDismiss={false}>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          data-note-status={placement}
          className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
        >
          <Glyph
            className={stale ? "h-3 w-3 text-status-warning" : "h-3 w-3"}
            aria-hidden="true"
            data-severity-glyph={stale ? "" : undefined}
          />
          {stale ? "Outdated" : "Not shown"}
        </span>
      </TooltipTrigger>
      {/* Above, so the note it explains stays readable beneath it. */}
      <TooltipContent side="top">{explainPlacement(placement, anchor, draft)}</TooltipContent>
    </Tooltip>
  );
}

export const DiffNoteCard = memo(function DiffNoteCard({ note, placement }: DiffNoteCardProps) {
  const saveNote = useDiffNotesStore((s) => s.saveNote);
  const deleteNote = useDiffNotesStore((s) => s.deleteNote);
  const restoreNote = useDiffNotesStore((s) => s.restoreNote);

  const cardRef = useRef<HTMLElement>(null);

  // Deletes at once and offers Undo, the app's pattern for a small reversible
  // loss (D0) — a confirm on every note would train the click-through.
  const handleDelete = (event: ReactMouseEvent) => {
    const deleted = note;
    returnFocusTo(deleteFocusSuccessor(cardRef.current), closedVia(event));
    deleteNote(deleted.id);
    notify({
      type: "success",
      title: "Note deleted",
      message: capitalize(nameAnchor(deleted.anchor)),
      priority: "high",
      transient: true,
      duration: UNDO_TOAST_DURATION_MS,
      context: { eventKind: "uiFeedback" },
      action: { label: "Undo", onClick: () => restoreNote(deleted) },
    });
  };
  // The edit is the pane session's, not the card's: a refresh or a layout switch
  // remounts the card, or moves it between the table and the fallback list, and
  // the rewrite carries on in whichever card shows the note next.
  const session = useDiffNoteDraftSession();
  const noteId = note.id;
  const editing = useDiffNoteDraftState(session, (state) => state.edits[noteId] === true);
  const [focusOwner] = useState(() => ({}));
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const closedViaRef = useRef<DiffNoteCloseVia | null>(null);
  const openEditor = () => {
    session.requestFocus(editDraftBodyKey(noteId), focusOwner);
    session.openEdit(noteId);
  };
  const closeEditor = (via: DiffNoteCloseVia) => {
    closedViaRef.current = via;
    session.closeEdit(noteId);
  };

  // The Edit button comes back only once the editor has gone, so focus waits
  // for that render.
  useEffect(() => {
    const via = closedViaRef.current;
    if (editing || !via) return;
    closedViaRef.current = null;
    returnFocusTo(editButtonRef.current, via);
  }, [editing]);

  const anchorLabel = describeAnchor(note.anchor);

  return (
    <article
      ref={cardRef}
      data-note-card=""
      className="diff-note"
      data-testid="diff-note"
      data-stale={placement === "stale" || undefined}
      aria-label={nameAnchor(note.anchor)}
    >
      <div className={NOTE_HEADER_CLASS}>
        <span>{anchorLabel}</span>
        {placement && <DiffNoteStatus placement={placement} anchor={note.anchor} />}
        {!editing && (
          // Pulled out by the icon buttons' own inset, so the trash glyph lines
          // up with the card's padding the way the anchor text does on the left.
          <span className="-mr-1.5 ml-auto flex shrink-0 items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  ref={editButtonRef}
                  data-note-edit=""
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Edit note"
                  onClick={openEditor}
                >
                  <Pencil />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Edit note</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost-danger"
                  size="icon-xs"
                  aria-label="Delete note"
                  onClick={handleDelete}
                >
                  <Trash2 />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Delete note</TooltipContent>
            </Tooltip>
          </span>
        )}
      </div>
      {editing ? (
        <DiffNoteEditor
          key={noteId}
          session={session}
          bodyKey={editDraftBodyKey(noteId)}
          focusOwner={focusOwner}
          initialBody={note.body}
          label={`Edit ${nameAnchor(note.anchor)}`}
          saveLabel="Save"
          onSave={(body, via) => {
            saveNote(note, body);
            closeEditor(via);
          }}
          onCancel={closeEditor}
        />
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm text-text-primary">{note.body}</p>
      )}
    </article>
  );
});

/**
 * A file's pending notes for a body with no diff table to hang them on. Line
 * notes can't be placed without rows, so they read as not in view. Notes still
 * being written are listed too, so a switch to a layout without the table
 * doesn't hide one mid-sentence.
 */
export function PendingFileNotes({
  worktreePath,
  filePath,
}: {
  worktreePath: string;
  filePath: string;
}) {
  const session = useDiffNoteDraftSession();
  const fileKey = diffNoteFileKey(worktreePath, filePath);
  const notes = useDiffNotesStore(
    useShallow((state) => selectDiffNotes(state, worktreePath, filePath))
  );
  const lineDraft = useDiffNoteDraftState(session, (state) => state.lines[fileKey] ?? null);
  const fileDraftOpen = useDiffNoteDraftState(session, (state) => state.files[fileKey] === true);
  const listRef = useRef<HTMLDivElement>(null);
  // Nothing in this list opened the draft, so a closed one hands focus to the
  // pane's path pill, the control naming the same file, as a deleted card does.
  const handFocusBack = (via: DiffNoteCloseVia) =>
    returnFocusTo(
      listRef.current
        ?.closest("[data-panel-id]")
        ?.querySelector<HTMLElement>("[data-toolbar-path]") ?? null,
      via
    );
  if (notes.length === 0 && !lineDraft && !fileDraftOpen) return null;
  return (
    <DiffNoteDraftContext value={session}>
      <div ref={listRef} className="diff-note-list" data-testid="diff-pending-file-notes">
        {sortDiffNotes(notes).map((note) => (
          <DiffNoteCard
            key={note.id}
            note={note}
            placement={note.anchor.kind === "file" ? undefined : "unplaced"}
          />
        ))}
        {lineDraft && (
          <DiffNoteComposer
            worktreePath={worktreePath}
            filePath={filePath}
            anchor={lineDraft}
            placement="unplaced"
            onDone={handFocusBack}
          />
        )}
        {fileDraftOpen && (
          <DiffNoteComposer
            worktreePath={worktreePath}
            filePath={filePath}
            anchor={FILE_ANCHOR}
            onDone={handFocusBack}
          />
        )}
      </div>
    </DiffNoteDraftContext>
  );
}

const FILE_ANCHOR: DiffNoteAnchor = { kind: "file" };
