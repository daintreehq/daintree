import { cn } from "@/lib/utils";
import { getNoteDisplayTitle } from "@/lib/noteTitleDisplay";
import { formatTimeAgo } from "@/utils/timeAgo";
import type { NoteListItem as NoteListItemType } from "@/clients/notesClient";
import type { UseNoteTitleEditReturn } from "@/hooks/useNoteTitleEdit";
import { Pencil, Search, Trash2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const noteTitleBaseClass =
  "flex-1 min-w-0 m-0 px-1 py-0.5 text-sm font-medium leading-tight border rounded box-border";

const ICON_CLASS = "w-3.5 h-3.5 mr-2 shrink-0";

interface NoteListItemProps {
  note: NoteListItemType;
  index: number;
  isSelected: boolean;
  isHighlighted: boolean;
  titleEdit: UseNoteTitleEditReturn;
  onSelect: (note: NoteListItemType, index: number) => void;
  onDelete: (note: NoteListItemType, e: React.MouseEvent) => void;
  onReveal?: (note: NoteListItemType) => void;
}

export function NoteListItemRow({
  note,
  index,
  isSelected,
  isHighlighted,
  titleEdit,
  onSelect,
  onDelete,
  onReveal,
}: NoteListItemProps) {
  const isEditing = titleEdit.editingNoteId === note.id;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          key={note.id}
          role="option"
          aria-selected={isSelected}
          className={cn(
            "relative flex items-start px-3 py-1.5 cursor-pointer transition-colors group",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-1",
            isSelected
              ? "bg-surface-panel-elevated shadow-sm text-canopy-text before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-r before:bg-canopy-accent before:content-['']"
              : isHighlighted
                ? "bg-overlay-subtle text-canopy-text"
                : "text-canopy-text/70 hover:bg-overlay-subtle hover:text-canopy-text"
          )}
          onClick={() => onSelect(note, index)}
          onDoubleClick={(e) => titleEdit.handleStartRename(note, e)}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-1 min-w-0">
              <input
                ref={isEditing ? titleEdit.titleInputRef : null}
                type="text"
                value={isEditing ? titleEdit.editingTitle : getNoteDisplayTitle(note)}
                placeholder="Untitled"
                readOnly={!isEditing}
                onChange={(e) => {
                  if (isEditing) titleEdit.setEditingTitle(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (isEditing) titleEdit.handleTitleKeyDown(note, e);
                }}
                onBlur={() => {
                  if (isEditing) titleEdit.handleTitleBlur(note);
                }}
                onClick={(e) => {
                  if (isEditing) e.stopPropagation();
                }}
                tabIndex={isEditing ? 0 : -1}
                className={cn(
                  noteTitleBaseClass,
                  "appearance-none focus:outline-none",
                  isEditing
                    ? "bg-canopy-sidebar border-canopy-accent text-canopy-text cursor-text"
                    : "bg-transparent border-transparent text-inherit truncate cursor-default pointer-events-none"
                )}
              />
              {!isEditing && (
                <span className="shrink-0 text-[11px] text-canopy-text/40 tabular-nums">
                  {formatTimeAgo(note.modifiedAt)}
                </span>
              )}
            </div>
            <div className="text-[11px] text-canopy-text/40 truncate mt-0.5 px-1">
              {note.preview || "Empty note"}
            </div>
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => onDelete(note, e)}
                  className="shrink-0 opacity-0 group-hover:opacity-100 p-1 rounded-[var(--radius-sm)] hover:bg-status-error/10 text-canopy-text/40 hover:text-status-error transition"
                  aria-label="Delete note"
                >
                  <Trash2 size={12} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Delete note</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => {
            const syntheticEvent = { stopPropagation: () => {} } as React.MouseEvent;
            titleEdit.handleStartRename(note, syntheticEvent);
          }}
        >
          <Pencil className={ICON_CLASS} />
          Rename Note
        </ContextMenuItem>
        {onReveal && (
          <ContextMenuItem onSelect={() => onReveal(note)}>
            <Search className={ICON_CLASS} />
            Reveal in Notes Panel
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          destructive
          onSelect={() => {
            const syntheticEvent = { stopPropagation: () => {} } as React.MouseEvent;
            onDelete(note, syntheticEvent);
          }}
        >
          <Trash2 className={ICON_CLASS} />
          Delete Note
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
