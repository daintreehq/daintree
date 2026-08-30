import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { parseChord } from "@/lib/kbdShortcut";

export const KBD_CLASS =
  "px-1.5 py-0.5 rounded-sm text-xs font-mono tabular-nums leading-none bg-overlay-subtle text-text-secondary border border-border-subtle";

/**
 * The same chip, tightened for a dense one-line list row.
 *
 * Only the box changes — glyph size, padding and the gap between keys. The
 * border, fill and font stay, because what the chip is for is telling a key
 * apart from the words beside it, and that is carried by the border and the
 * monospace face rather than by its size. At the full size a three-key chord
 * repeated down a list of rows draws a second grid over the surface, which is
 * loudest on the light themes.
 */
export const KBD_COMPACT_CLASS =
  "px-1 py-px rounded-sm text-3xs font-mono tabular-nums leading-none bg-overlay-subtle text-text-secondary border border-border-subtle";

export interface KbdProps {
  children: React.ReactNode;
  className?: string;
}

export function Kbd({ children, className }: KbdProps) {
  return <kbd className={cn(KBD_CLASS, className)}>{children}</kbd>;
}

export interface KbdChordProps {
  shortcut: string;
  /** Override platform detection. Defaults to `isMac()`. */
  isMac?: boolean;
  className?: string;
  "aria-label"?: string;
  /**
   * Tighten the chips for a dense list row. Same grammar, smaller box — see
   * {@link KBD_COMPACT_CLASS}.
   */
  density?: "default" | "compact";
}

/**
 * Renders a keyboard chord as per-key chips using the neutral overlay surface.
 * macOS uses glyph keys with no `+` separator; Win/Linux uses spelled-out keys
 * separated by a small `+` character. Two-step chords (`Cmd+K T`) are joined
 * by a comma+space.
 */
export function KbdChord({
  shortcut,
  isMac: isMacProp,
  className,
  "aria-label": ariaLabel,
  density = "default",
}: KbdChordProps) {
  const mac = isMacProp ?? isMac();
  const steps = parseChord(shortcut, mac);
  if (steps.length === 0) return null;
  const compact = density === "compact";
  const keyClass = compact ? KBD_COMPACT_CLASS : KBD_CLASS;

  return (
    <span className={cn("inline-flex items-center", compact ? "gap-0.5" : "gap-1", className)}>
      <span className="sr-only">{ariaLabel ?? shortcut}</span>
      {steps.map((tokens, stepIndex) => (
        <Fragment key={stepIndex}>
          {stepIndex > 0 && (
            <span className="text-daintree-text/40 text-3xs select-none" aria-hidden>
              ,
            </span>
          )}
          <span className={cn("inline-flex items-center", compact ? "gap-px" : "gap-0.5")}>
            {tokens.map((token, tokenIndex) => (
              <Fragment key={tokenIndex}>
                {tokenIndex > 0 && !mac && (
                  <span className="text-daintree-text/40 text-3xs select-none" aria-hidden>
                    +
                  </span>
                )}
                <kbd aria-hidden="true" className={keyClass}>
                  {token}
                </kbd>
              </Fragment>
            ))}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
