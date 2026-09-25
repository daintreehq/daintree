import { useState } from "react";
import { SendHorizontal } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TOOLBAR_ICON_CLASS } from "@/components/FileViewer/FileViewerToolbar";
import { selectDiffNotes, useDiffNotesStore } from "@/store/diffNotesStore";
import {
  deliverDiffNotes,
  useDiffNoteTargets,
  type DiffNoteDeliveryResult,
} from "@/hooks/useDiffNoteDelivery";

export type DiffNoteSendScope = "file" | "all";

export interface DiffNoteSendRequest {
  targetId: string;
  scope: DiffNoteSendScope;
}

interface DiffNotesSendMenuProps {
  worktreePath: string;
  /** Worktree-relative path of the file on screen. */
  filePath: string;
  onResult: (request: DiffNoteSendRequest, result: DiffNoteDeliveryResult) => void;
}

/**
 * Sends a worktree's pending notes into an agent's composer. Scope defaults to
 * the file on screen; "All files" is a deliberate second choice because it
 * reaches notes the reviewer can't see from here.
 */
export function DiffNotesSendMenu({ worktreePath, filePath, onResult }: DiffNotesSendMenuProps) {
  const allNotes = useDiffNotesStore(useShallow((state) => selectDiffNotes(state, worktreePath)));
  const fileCount = allNotes.filter((note) => note.filePath === filePath).length;
  const [scope, setScope] = useState<DiffNoteSendScope>("file");

  if (allNotes.length === 0) return null;

  const effectiveScope: DiffNoteSendScope = fileCount === 0 ? "all" : scope;
  const count = effectiveScope === "file" ? fileCount : allNotes.length;

  const send = (targetId: string) => {
    onResult(
      { targetId, scope: effectiveScope },
      sendDiffNotes(worktreePath, filePath, targetId, effectiveScope)
    );
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) setScope("file");
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="diff-notes-send"
          className="flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-md)] text-xs text-text-secondary transition-colors hover:text-text-primary hover:bg-border-default"
        >
          <SendHorizontal className={TOOLBAR_ICON_CLASS} aria-hidden="true" />
          Send notes
          <span className="tabular-nums">{allNotes.length}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="min-w-[220px]">
        <DropdownMenuLabel>Notes to send</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          aria-label="Notes to send"
          value={effectiveScope}
          onValueChange={(value) => setScope(value === "all" ? "all" : "file")}
        >
          <DropdownMenuRadioItem
            value="file"
            disabled={fileCount === 0}
            onSelect={(event) => event.preventDefault()}
          >
            <span className="flex flex-1 items-center gap-2">
              This file
              <span className="ml-auto text-3xs tabular-nums text-text-secondary">{fileCount}</span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="all" onSelect={(event) => event.preventDefault()}>
            <span className="flex flex-1 items-center gap-2">
              All files
              <span className="ml-auto text-3xs tabular-nums text-text-secondary">
                {allNotes.length}
              </span>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          Paste {count} {count === 1 ? "note" : "notes"} into
        </DropdownMenuLabel>
        <DiffNoteTargetItems onSend={send} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Mounted only while the menu is open, so a closed pane holds no subscription
// to the panel map.
function DiffNoteTargetItems({ onSend }: { onSend: (targetId: string) => void }) {
  const targets = useDiffNoteTargets();
  if (targets.length === 0) {
    return <DropdownMenuItem disabled>No agents running</DropdownMenuItem>;
  }
  return (
    <>
      {targets.map((target) => (
        <DropdownMenuItem
          key={target.id}
          disabled={target.isInputLocked}
          onSelect={() => onSend(target.id)}
        >
          <span className="truncate">{target.title}</span>
        </DropdownMenuItem>
      ))}
    </>
  );
}

/** Resolves the scope against the store at send time, not at menu render. */
export function sendDiffNotes(
  worktreePath: string,
  filePath: string,
  targetId: string,
  scope: DiffNoteSendScope
): DiffNoteDeliveryResult {
  const state = useDiffNotesStore.getState();
  const notes = selectDiffNotes(state, worktreePath, scope === "file" ? filePath : undefined);
  return deliverDiffNotes(targetId, notes);
}
