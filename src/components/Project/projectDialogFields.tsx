import { basename, normalize } from "@shared/utils/path";
import { cn } from "@/lib/utils";

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

export const FIELD_LABEL_CLASS = "text-sm font-medium text-daintree-text/80";

export const FIELD_INPUT_CLASS =
  "min-h-9 w-full rounded-md border border-daintree-border bg-daintree-bg px-3 py-1.5 text-sm text-daintree-text placeholder:text-text-placeholder focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/50 disabled:opacity-50 aria-invalid:border-status-error";

/** Picker-backed fields: muted fill signals "typing here does nothing". */
export const FIELD_READONLY_INPUT_CLASS =
  "min-h-9 flex-1 truncate rounded-md border border-daintree-border bg-muted/50 px-3 py-1.5 text-sm font-mono text-daintree-text/70";

export const FIELD_CHECKBOX_CLASS =
  "h-4 w-4 shrink-0 rounded border-daintree-border accent-daintree-accent";

/** Sits beside a `FIELD_READONLY_INPUT_CLASS` input, matched to its height. */
export const FIELD_BROWSE_BUTTON_CLASS = "min-h-9 shrink-0 gap-1.5";

/** Aligns caption/error text under an input that shares its row with `ProjectEmojiButton` (h-9 + gap-2). */
export const FIELD_EMOJI_ROW_INDENT = "ml-11";

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
  const ancestors = displayPath.slice(0, displayPath.length - leaf.length);

  return (
    <p
      className={cn("flex text-xs font-mono text-daintree-text/50", className)}
      title={displayPath}
    >
      <span className="min-w-0 truncate">{ancestors}</span>
      {/* Pinned against the ancestors, but still capped: a leaf wider than the
          dialog would otherwise overflow into a horizontal scroll. */}
      <span className="max-w-full shrink-0 truncate">{leaf}</span>
    </p>
  );
}
