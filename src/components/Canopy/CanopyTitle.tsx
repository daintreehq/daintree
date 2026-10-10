import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  inlineRenameFieldClassName,
  inlineRenameFieldInputProps,
} from "@/components/Panel/inlineRenameField";

interface CanopyTitleProps {
  title: string;
  /**
   * Rename the terminal; an empty title puts back the one Daintree gives it.
   * Settles once main has it, and rejects when it was refused.
   */
  onRename: (title: string) => Promise<void>;
  /** Bumped to start a rename from elsewhere: the row's menu, or F2 on the row. */
  renameRequest?: number;
}

/**
 * The selected agent's name in its title bar, renamed the way a grid pane's
 * is: double-click or F2, Enter to keep it — Enter on an empty field puts back
 * the default — and Escape to leave it as it was. Leaving the field keeps a
 * change but never clears the name, whose intent is unclear.
 */
export function CanopyTitle({ title, onRename, renameRequest }: CanopyTitleProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  // The newest name typed, shown from Enter until main's own report of it
  // lands; one refused goes back to the name it had. A reset clears it, so an
  // older name typed before can never come back.
  const [pending, setPending] = useState<{ from: string; to: string } | null>(null);
  const shown = pending !== null && pending.from === title ? pending.to : title;
  const titleRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // When the rename began. A menu closing just after hands focus back to its
  // row, which would end the rename before it could be seen: a blur this soon
  // takes focus back instead, as a grid pane's rename does.
  const startedAtRef = useRef(0);

  // From the name on show: one typed a moment ago, not yet reported back, is
  // the one to edit.
  const start = () => {
    startedAtRef.current = Date.now();
    setValue(shown);
    setEditing(true);
  };

  // Once per request. One the pane finds as it mounts is for it: renaming
  // another run from its row opens that run first. The list drops a request
  // once its run is left, so coming back to it later starts nothing.
  const handledRequest = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (renameRequest === undefined || renameRequest === handledRequest.current) return;
    handledRequest.current = renameRequest;
    startedAtRef.current = Date.now();
    setValue(shown);
    setEditing(true);
  }, [renameRequest, shown]);

  // The field takes focus with its text selected, so typing replaces the name.
  // Started from the row's menu, the menu still holds focus as this runs and
  // takes it back while it closes, so focus is asked for again once that has
  // settled — unless the user is already typing or clicking in the field.
  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
    const timer = setTimeout(() => {
      if (document.activeElement === input) return;
      input.focus();
      input.select();
    }, 200);
    const cancel = () => clearTimeout(timer);
    input.addEventListener("keydown", cancel);
    input.addEventListener("pointerdown", cancel);
    return () => {
      cancel();
      input.removeEventListener("keydown", cancel);
      input.removeEventListener("pointerdown", cancel);
    };
  }, [editing]);

  const commit = (allowReset: boolean) => {
    setEditing(false);
    const next = value.trim();
    // An unchanged name is no rename: an accidental Enter never locks it.
    if (next === shown.trim()) return;
    if (!next && !allowReset) return;
    const rename = next ? { from: title, to: next } : null;
    setPending(rename);
    onRename(next).catch(() => {
      if (rename) setPending((current) => (current === rename ? null : current));
    });
  };

  const backToTitle = () => requestAnimationFrame(() => titleRef.current?.focus());

  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Every key here is the field's: none reaches Canopy's own keys, and Escape
    // leaves the rename rather than closing the panel.
    event.stopPropagation();
    if (event.key === "Enter") {
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      commit(true);
      backToTitle();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setEditing(false);
      setValue(shown);
      backToTitle();
    }
  };

  if (editing) {
    // The field takes exactly the box the name had, as the grid pane's does:
    // an invisible copy sizes the cell and the input fills it.
    return (
      <div className="grid min-w-0 shrink" data-canopy-rename="">
        <span
          aria-hidden="true"
          className="invisible col-start-1 row-start-1 block h-6 min-w-[6ch] truncate text-xs leading-6 font-medium"
        >
          {value || title}
        </span>
        <input
          ref={inputRef}
          {...inlineRenameFieldInputProps}
          size={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onFieldKeyDown}
          onBlur={() => {
            if (Date.now() - startedAtRef.current < 300) {
              requestAnimationFrame(() => inputRef.current?.focus());
              return;
            }
            commit(false);
          }}
          aria-label={`Rename ${title}`}
          className={cn(
            inlineRenameFieldClassName,
            "col-start-1 row-start-1 -mx-1 h-6 w-[calc(100%+0.5rem)] leading-6"
          )}
        />
      </div>
    );
  }

  // A heading, as the pane's name; the name itself is the rename control.
  return (
    <h3 className="min-w-[6ch] shrink truncate font-sans text-xs leading-6 font-medium text-text-primary">
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            ref={titleRef}
            tabIndex={0}
            role="button"
            aria-keyshortcuts="F2"
            aria-label={`${shown}, rename`}
            onDoubleClick={(event) => {
              event.stopPropagation();
              start();
            }}
            // A click with no pointer behind it is assistive technology pressing
            // the button; a mouse renames on a double-click, as a grid pane's does.
            onClick={(event) => {
              if (event.detail !== 0) return;
              event.stopPropagation();
              start();
            }}
            onKeyDown={(event) => {
              if (event.key !== "F2" && event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              start();
            }}
            className="block min-h-6 cursor-text truncate rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
          >
            {shown}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{`${shown} — Double-click or F2 to rename`}</TooltipContent>
      </Tooltip>
    </h3>
  );
}
