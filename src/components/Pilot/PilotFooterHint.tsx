import { cn } from "@/lib/utils";
import { KBD_CLASS } from "@/components/ui/AppPaletteDialog";
import { Spinner } from "@/components/ui/Spinner";

/**
 * The footer's key hints, which are also its buttons.
 *
 * They were `<span>`s carrying a keycap, which made Park and Worktrees
 * keyboard-only in practice: a user driving the palette with the mouse could
 * open a run by clicking it and had no way at all to park one, and the drill
 * gesture's only pointer form was an undiscoverable click on a heading that
 * gives no sign of being a control. A `<button>` costs nothing visually — the
 * keycap and the verb are unchanged — and it makes the hint the thing it was
 * already describing.
 *
 * The keycap stays inside the button rather than beside it, so the accessible
 * name is "⌥↵ Park" and voice control's "click Park" still matches on the
 * visible word.
 *
 * Shared by the list's footer and the park editor's, so the dialog speaks one
 * grammar for "this key does this" in both modes — the same grammar every
 * palette footer uses. `keys` is optional for a verb with no chord (Unpark).
 *
 * `busy` works the way `Button`'s loading does, for the same two reasons: the
 * content goes invisible under a centred spinner so the footer never reflows,
 * and the button is `aria-disabled` rather than `disabled`, because disabling
 * the focused control blurs it and strands the keyboard on `document.body`.
 */
export function PilotFooterHint({
  keys,
  label,
  onClick,
  testId,
  disabled = false,
  busy = false,
  describedBy,
  noSubmit = false,
}: {
  keys?: string;
  label: string;
  onClick: () => void;
  testId: string;
  disabled?: boolean;
  busy?: boolean;
  describedBy?: string;
  /** Opts the button out of the park editor's Enter-to-submit. */
  noSubmit?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        if (!busy) onClick();
      }}
      disabled={disabled}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      aria-describedby={describedBy}
      data-no-submit={noSubmit ? "" : undefined}
      data-testid={testId}
      className={cn(
        "relative flex shrink-0 items-center rounded-[var(--radius-sm)] px-1 py-0.5 transition-colors",
        "hover:bg-overlay-subtle hover:text-text-primary disabled:pointer-events-none disabled:opacity-50",
        "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
      )}
    >
      <span className={cn("flex items-center", busy && "invisible")}>
        {keys !== undefined && <kbd className={KBD_CLASS}>{keys}</kbd>}
        <span className={cn(keys !== undefined && "ml-1.5")}>{label}</span>
      </span>
      {busy && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner size="xs" />
        </span>
      )}
    </button>
  );
}
