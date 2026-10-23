import { useEffect, useId, useState } from "react";
import type {
  PluginWorktreeDeleteNote,
  WorktreeDeleteNoteSource,
  WorktreeDeleteNotesAnswer,
} from "@shared/types/plugin";
import { pluginClient } from "@/clients/pluginClient";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { useLiveRegionReady } from "@/components/ui/Skeleton";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";

/** One plugin's place in the confirmation: still being asked, or what it said. */
export interface WorktreeDeleteNoteRow {
  source: WorktreeDeleteNoteSource;
  answer: WorktreeDeleteNotesAnswer | "pending";
}

/**
 * Ask every plugin with a delete check about `worktreeId` (#13805), and keep
 * one row per plugin that updates as its answer arrives. `null` asks nothing.
 * Late answers for a worktree the caller has moved off, or after unmount, are
 * dropped; main bounds each ask by its own deadline, so there is nothing to
 * cancel there.
 *
 * A plugin still being asked has a row only past the inline loading gate, so
 * one that answers at once never flashes "Checking with…".
 */
export function useWorktreeDeleteNotes(worktreeId: string | null): WorktreeDeleteNoteRow[] {
  const [rows, setRows] = useState<WorktreeDeleteNoteRow[]>([]);
  const [pendingShown, setPendingShown] = useState(false);

  useEffect(() => {
    setRows([]);
    setPendingShown(false);
    if (worktreeId === null) return;
    let cancelled = false;
    const gate = setTimeout(() => setPendingShown(true), UI_INLINE_LOADING_GATE_MS);
    const settle = (pluginId: string, answer: WorktreeDeleteNotesAnswer | null) => {
      if (cancelled) return;
      setRows((current) =>
        answer === null
          ? current.filter((row) => row.source.pluginId !== pluginId)
          : current.map((row) => (row.source.pluginId === pluginId ? { ...row, answer } : row))
      );
    };
    // Started inside a promise so a bridge that throws synchronously reads as
    // a failed list, like any other, rather than breaking the dialog.
    Promise.resolve()
      .then(() => pluginClient.getWorktreeDeleteNoteSources())
      .then((sources) => {
        if (cancelled) return;
        setRows(sources.map((source) => ({ source, answer: "pending" })));
        for (const { pluginId } of sources) {
          Promise.resolve()
            .then(() => pluginClient.getWorktreeDeleteNotes(worktreeId, pluginId))
            .then((answer) => settle(pluginId, answer))
            .catch(() => settle(pluginId, { status: "no-answer" }));
        }
      })
      // With no list there is no plugin to name, so there is nothing to show.
      .catch(() => {});
    return () => {
      cancelled = true;
      clearTimeout(gate);
    };
  }, [worktreeId]);

  return pendingShown ? rows : rows.filter((row) => row.answer !== "pending");
}

// `secondary`, not `muted`, for the reason the readiness checks give: the glyph
// is the only visual severity carrier and owes the 3:1 non-text floor.
const SEVERITY = {
  warning: { Icon: SEVERITY_GLYPH.warning, toneClass: "text-status-warning" },
  info: { Icon: SEVERITY_GLYPH.info, toneClass: "text-text-secondary" },
} as const;

function NoteItem({ pluginName, note }: { pluginName: string; note: PluginWorktreeDeleteNote }) {
  const { Icon, toneClass } = SEVERITY[note.severity];
  return (
    <li
      data-testid="worktree-delete-note"
      data-severity={note.severity}
      className="flex items-start gap-1.5 text-text-primary"
    >
      <Icon className={cn("w-3.5 h-3.5 mt-0.5 shrink-0", toneClass)} aria-hidden="true" />
      <span className="sr-only">{`${note.severity === "warning" ? "Warning" : "Note"} from `}</span>
      <span className="min-w-0 break-words">
        <span className="font-medium">{pluginName}</span>
        <span className="text-text-secondary">: </span>
        {note.text}
      </span>
    </li>
  );
}

function StatusItem({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <li data-testid={testId} className="flex items-start gap-1.5 text-text-secondary">
      {/* Holds the glyph column so a pending row's text doesn't shift when its
          answer arrives with one. */}
      <span className="w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{children}</span>
    </li>
  );
}

/**
 * What plugins say about a worktree about to be deleted (#13805), each note
 * named after its plugin. Annotation only: nothing here reaches the delete,
 * its tier or its typed confirmation, and a plugin still answering never holds
 * the confirm button. Renders nothing when no plugin is asked.
 *
 * `heading` labels the list for a confirmation that sections its body; a
 * compact one (a bulk row) leaves it out.
 */
export function WorktreeDeleteNotes({
  worktreeId,
  heading,
  className,
}: {
  worktreeId: string | null;
  heading?: string;
  className?: string;
}) {
  // A plugin that answered with nothing to say takes no row.
  const rows = useWorktreeDeleteNotes(worktreeId).filter(
    ({ answer }) => answer === "pending" || answer.status === "no-answer" || answer.notes.length > 0
  );
  if (rows.length === 0) return null;
  return <NotesSection rows={rows} heading={heading} className={className} />;
}

function NotesSection({
  rows,
  heading,
  className,
}: {
  rows: WorktreeDeleteNoteRow[];
  heading?: string;
  className?: string;
}) {
  const headingId = useId();
  // The live region mounts empty and is filled a commit later, or its first
  // rows would arrive with it and go unannounced.
  const ready = useLiveRegionReady();
  return (
    <div className={className} data-testid="worktree-delete-notes">
      {heading !== undefined && (
        <span id={headingId} role="heading" aria-level={3} className={SECTION_LABEL_CLASS}>
          {heading}
        </span>
      )}
      {/* Bounded so a late answer can't push the confirm button down a short
          dialog; polite so an arrival is announced without interrupting. */}
      <ul
        aria-labelledby={heading !== undefined ? headingId : undefined}
        aria-label={heading === undefined ? "Notes from plugins" : undefined}
        aria-live="polite"
        className={cn(
          "space-y-1 max-h-32 overflow-y-auto",
          heading !== undefined ? "mt-2 text-sm" : "text-xs"
        )}
      >
        {(ready ? rows : []).map(({ source, answer }) => {
          if (answer === "pending") {
            return (
              <StatusItem key={source.pluginId} testId="worktree-delete-note-pending">
                Checking with {source.pluginName}…
              </StatusItem>
            );
          }
          if (answer.status === "no-answer") {
            return (
              <StatusItem key={source.pluginId} testId="worktree-delete-note-no-answer">
                {source.pluginName} didn&apos;t answer
              </StatusItem>
            );
          }
          return answer.notes.map((note, index) => (
            <NoteItem
              key={`${source.pluginId}:${index}`}
              pluginName={source.pluginName}
              note={note}
            />
          ));
        })}
      </ul>
    </div>
  );
}
