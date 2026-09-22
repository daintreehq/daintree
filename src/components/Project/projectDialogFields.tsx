import type { InputHTMLAttributes, ReactNode } from "react";
import { FolderOpen } from "lucide-react";
import { basename, normalize } from "@shared/utils/path";
import { cn } from "@/lib/utils";
import {
  SegmentedRadioGroup,
  type SegmentedRadioOption,
} from "@/components/ui/SegmentedRadioGroup";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FIELD_SURFACE } from "@/components/Worktree/views/WorktreeFormLayout";

/**
 * Shared form conventions for the project-entry dialogs (clone, create folder,
 * git init, move/rename). These five dialogs are near-identical twins that had
 * each hand-copied their field styling and drifted apart — different radii,
 * backgrounds, label tones, and control heights across dialogs a user hits back
 * to back. Import from here rather than re-typing a class string.
 *
 * Heights are `min-h-9` so every control lines up with `ProjectEmojiButton`
 * (`h-9`) and the browse buttons, without clipping if the text ever outgrows the
 * box.
 */

export const FIELD_LABEL_CLASS = "text-sm font-medium text-text-primary";

/**
 * The invalid-focused case needs the error ring, not the accent one. Left to the
 * plain `focus:` rule, an invalid field drew a green accent ring concentric with
 * its red error border: two colour signals disagreeing inside 2px, with the
 * louder of the two saying nothing is wrong.
 */
export const FIELD_INPUT_CLASS =
  "min-h-9 w-full rounded-md border border-border-default bg-surface-canvas px-3 py-1.5 text-sm text-text-primary placeholder:text-text-placeholder focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/50 disabled:opacity-50 aria-invalid:border-status-error aria-invalid:focus:ring-status-error/50";

/** Picker-backed fields: muted fill signals "typing here does nothing". */
export const FIELD_READONLY_INPUT_CLASS =
  "min-h-9 flex-1 truncate rounded-md border border-border-default bg-muted/50 px-3 py-1.5 text-sm font-mono text-text-secondary";

export const FIELD_CHECKBOX_CLASS =
  "h-4 w-4 shrink-0 rounded border-border-default accent-accent-primary";

/** Sits beside a `FIELD_READONLY_INPUT_CLASS` input, matched to its height. */
export const FIELD_BROWSE_BUTTON_CLASS = "min-h-9 shrink-0 gap-1.5";

/** Aligns caption/error text under an input that shares its row with `ProjectEmojiButton` (h-9 + gap-2). */
export const FIELD_EMOJI_ROW_INDENT = "ml-11";

/**
 * One field-shaped box holding an input and an inline slot, on the label rail's
 * 32px chrome. The ring is hoisted to the box and scoped to the input, so the
 * pair lights up as one object; the slot's own button rings itself inset.
 */
const COMPOUND_FIELD = cn(
  FIELD_SURFACE,
  "flex h-8 items-center overflow-hidden",
  "has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-accent-primary has-[input:focus-visible]:outline-offset-2"
);

const COMPOUND_INPUT =
  "h-full min-w-0 flex-1 bg-transparent px-2.5 text-sm text-text-primary placeholder:text-text-placeholder focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-50";

/** A button that sits flush inside a {@link COMPOUND_FIELD}, separated by a hairline. */
export const FIELD_SLOT_BUTTON = cn(
  "flex h-full w-8 shrink-0 items-center justify-center border-border-subtle",
  "text-text-secondary transition-colors duration-150 ease-out",
  "hover:bg-overlay-hover hover:text-text-primary",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2",
  "disabled:cursor-not-allowed disabled:opacity-50"
);

/**
 * A folder chosen through the native picker. The path is a readonly input so it
 * stays focusable and copyable, but the whole field opens the picker: a field
 * that looks editable and silently ignores typing is the thing this replaces.
 */
export function DirectoryPickerField({
  id,
  value,
  onBrowse,
  disabled,
  placeholder = "Choose a folder…",
  browseLabel,
}: {
  id: string;
  value: string;
  onBrowse: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** Accessible name for the trailing button — name what is being chosen. */
  browseLabel: string;
}) {
  return (
    <div className={COMPOUND_FIELD}>
      <input
        id={id}
        type="text"
        value={value}
        readOnly
        aria-readonly="true"
        placeholder={placeholder}
        disabled={disabled}
        title={value || undefined}
        onClick={onBrowse}
        onKeyDown={(e) => {
          if (e.key === " " || (e.key === "Enter" && !value)) {
            e.preventDefault();
            onBrowse();
          }
        }}
        className={cn(
          COMPOUND_INPUT,
          "cursor-pointer truncate",
          // A path reads as a path; the empty prompt reads as copy.
          value && "font-mono text-xs"
        )}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onBrowse}
            disabled={disabled}
            aria-label={browseLabel}
            className={cn(FIELD_SLOT_BUTTON, "border-l")}
          >
            <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">
          <p>Browse for a folder</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * A text input with a leading slot inside the same box — the project emoji, so
 * the name and its glyph read as one identity rather than a swatch parked
 * beside a field.
 */
export function SlottedInputField({
  leading,
  invalid,
  className,
  ...inputProps
}: InputHTMLAttributes<HTMLInputElement> & {
  leading: ReactNode;
  invalid?: boolean;
}) {
  return (
    <div
      className={cn(
        COMPOUND_FIELD,
        // The error ring, not the accent one: an accent ring around a red
        // border is two colour signals disagreeing, the louder one saying
        // nothing is wrong.
        invalid && "border-status-error has-[input:focus-visible]:outline-status-error"
      )}
    >
      {leading}
      <input
        type="text"
        {...inputProps}
        aria-invalid={invalid || undefined}
        className={cn(COMPOUND_INPUT, className)}
      />
    </div>
  );
}

/**
 * A filesystem path that ellipsizes its ancestors instead of its leaf — the leaf
 * folder is what identifies the project, and a plain `truncate` eats exactly
 * that. Both halves are derived from the *normalized* path because `basename`
 * normalizes internally: slicing the raw string by the normalized leaf's length
 * duplicates characters whenever normalizing shortens the input, so a trailing
 * separator renders "…/pproj".
 */
export function PathCaption({ path, className }: { path: string; className?: string }) {
  const displayPath = normalize(path);
  const leaf = basename(displayPath);
  // The separator rides with the leaf, not with the ancestors. Left inside the
  // truncating span it is the first thing the ellipsis eats, and the caption
  // then reads as two unrelated strings ("…/some/pre  leaf") rather than as one
  // elided path ("…/leaf").
  const separatorIndex = displayPath.length - leaf.length - 1;
  const separator =
    separatorIndex >= 0 &&
    (displayPath[separatorIndex] === "/" || displayPath[separatorIndex] === "\\")
      ? displayPath[separatorIndex]
      : "";
  const ancestors = displayPath.slice(0, displayPath.length - leaf.length - separator.length);

  return (
    <p className={cn("flex text-xs font-mono text-text-secondary", className)} title={displayPath}>
      <span className="min-w-0 truncate">{ancestors}</span>
      {/* Pinned against the ancestors, but still capped: a leaf wider than the
          dialog would otherwise overflow into a horizontal scroll. */}
      <span className="max-w-full shrink-0 truncate">
        {separator}
        {leaf}
      </span>
    </p>
  );
}

/** Where a project from the clone or create dialog opens (#12594). */
export type ProjectOpenDestination = "current" | "new";

const OPEN_DESTINATION_OPTIONS: SegmentedRadioOption<ProjectOpenDestination>[] = [
  { value: "current", label: "This window" },
  { value: "new", label: "New window" },
];

/** The bare control, for forms that put "Open in" on a label rail. */
export function OpenDestinationControl({
  value,
  onChange,
  disabled,
}: {
  value: ProjectOpenDestination;
  onChange: (value: ProjectOpenDestination) => void;
  disabled?: boolean;
}) {
  return (
    <SegmentedRadioGroup
      options={OPEN_DESTINATION_OPTIONS}
      value={value}
      onChange={onChange}
      aria-label="Open in"
      disabled={disabled}
    />
  );
}

/**
 * Asked before the work starts rather than at the end: the clone dialog closes
 * itself on success, and both flows can chain into the git-init prompt, so a
 * choice offered afterwards would come too late.
 */
export function OpenDestinationField({
  value,
  onChange,
  disabled,
}: {
  value: ProjectOpenDestination;
  onChange: (value: ProjectOpenDestination) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <p className={FIELD_LABEL_CLASS}>Open in</p>
      <OpenDestinationControl value={value} onChange={onChange} disabled={disabled} />
    </div>
  );
}
