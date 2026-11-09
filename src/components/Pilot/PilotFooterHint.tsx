import { cn } from "@/lib/utils";
import { KbdChord } from "@/components/ui/Kbd";
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
 * name is the keys spoken by name and then the visible verb ("Option Return to
 * park"), and it contains the words a voice-control user reads off the button.
 *
 * Shared by the list's footer and the park editor's, so the dialog speaks one
 * grammar for "this key does this" in both modes — the same grammar every
 * palette footer uses: the key drawn by `KbdChord`, then a lowercase "to …".
 * `keys` is optional for a plain button with no chord (Unpark).
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
  /** A canonical combo ("Enter", "Alt+Enter"), drawn in the platform's own key names. */
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
        "relative flex min-w-0 items-center rounded-[var(--radius-sm)] px-1 py-0.5 transition-colors",
        "hover:bg-overlay-subtle hover:text-text-primary disabled:pointer-events-none disabled:opacity-50",
        "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
      )}
    >
      {/* The verb gives way before the keys do: off a Mac the chords are
          spelled out, and three of them overrun a narrow Linux window. */}
      <span className={cn("flex min-w-0 items-center", busy && "invisible")}>
        {keys !== undefined && (
          // The space isn't rendered between flex items, but it keeps the
          // spoken keys and the verb two words in the button's name ("Alt
          // Enter to park") wherever the items aren't blockified.
          <>
            <KbdChord shortcut={keys} className="shrink-0" />{" "}
          </>
        )}
        <span className={cn("min-w-0 truncate", keys !== undefined && "ml-1.5")}>{label}</span>
      </span>
      {busy && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner size="xs" />
        </span>
      )}
    </button>
  );
}
