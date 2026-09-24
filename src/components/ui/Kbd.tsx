import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { describeChord, parseChord } from "@/lib/kbdShortcut";

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

/**
 * No box at all — the chord as a bare monospace glyph run, the way a macOS
 * menu prints it.
 *
 * For places that show a binding beside EVERY item in a group. One boxed chip
 * tells a key apart from the words next to it; seven of them, each three keys
 * wide, draw twenty-one bordered rectangles over a surface that already has a
 * border per item, and the group stops reading as a row of actions. The
 * monospace face and the glyphs carry the "this is a key" signal on their own
 * once there is a run of them to compare against.
 */
export const KBD_BARE_CLASS = "font-mono tabular-nums leading-none text-xs text-text-secondary";

/**
 * The macOS modifier glyphs. JetBrains Mono's bundled subset has none of them,
 * so inside a mono chip they fall back glyph by glyph to whatever monospace
 * face has them, and ⇧ lands visibly smaller and thinner than ⌘ or the letter
 * beside it. The system UI face draws all four as a matched set.
 */
const MODIFIER_GLYPH = /^[⌘⇧⌥⌃]$/;

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
   * Tighten the chips for a dense list row (`compact`, same grammar in a
   * smaller box — see {@link KBD_COMPACT_CLASS}), or drop the box entirely
   * for a group where every item carries a binding (`bare`, see
   * {@link KBD_BARE_CLASS}).
   */
  density?: "default" | "compact" | "bare";
  /**
   * Key glyph colour. `secondary` (the default) suits a hint beside a label;
   * `primary` is for places where the keys are the content being read, such as
   * a shortcut editor's binding column. The class sits on each key, so a colour
   * on the wrapper cannot reach it.
   */
  foreground?: "secondary" | "primary";
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
  foreground = "secondary",
}: KbdChordProps) {
  const mac = isMacProp ?? isMac();
  const steps = parseChord(shortcut, mac);
  if (steps.length === 0) return null;
  const compact = density === "compact";
  const bare = density === "bare";
  const baseKeyClass = bare ? KBD_BARE_CLASS : compact ? KBD_COMPACT_CLASS : KBD_CLASS;
  // A straight swap rather than cn(): tailwind-merge reads `text-xs` as setting
  // line-height and would drop the classes' `leading-none`.
  const keyClass =
    foreground === "primary"
      ? baseKeyClass.replace("text-text-secondary", "text-text-primary")
      : baseKeyClass;

  return (
    <span
      className={cn(
        "inline-flex items-center",
        bare ? "gap-0" : compact ? "gap-0.5" : "gap-1",
        className
      )}
    >
      {/* Spoken, not the raw string: "Cmd+Shift+P" and the glyphs both read
          badly aloud; "Command Shift P" is what a listener needs. */}
      <span className="sr-only">{ariaLabel ?? describeChord(shortcut, mac)}</span>
      {steps.map((tokens, stepIndex) => (
        <Fragment key={stepIndex}>
          {/* In `bare` the comma reads as punctuation — attached to the step
              before it and set at the glyphs' own size — so a chord prints
              "⌘K, ⌘S" rather than floating a small mark between two gaps. */}
          {stepIndex > 0 && (
            <span
              className={cn("text-text-secondary select-none", bare ? "mr-1" : "text-3xs")}
              aria-hidden
            >
              ,
            </span>
          )}
          {/* No gap in `bare`: with no box to separate, the glyphs read as one
              chord the way a menu prints them — spacing them re-creates the
              fragmentation the boxes caused. */}
          <span
            className={cn(
              "inline-flex items-center",
              bare ? "gap-0" : compact ? "gap-px" : "gap-0.5"
            )}
          >
            {tokens.map((token, tokenIndex) => (
              <Fragment key={tokenIndex}>
                {tokenIndex > 0 && !mac && (
                  <span className="text-text-secondary text-3xs select-none" aria-hidden>
                    +
                  </span>
                )}
                <kbd
                  aria-hidden="true"
                  className={
                    MODIFIER_GLYPH.test(token)
                      ? keyClass.replace("font-mono", "font-sans")
                      : keyClass
                  }
                >
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
