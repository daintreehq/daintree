import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { parseChord } from "@/lib/kbdShortcut";

export interface KbdProps {
  children: React.ReactNode;
  className?: string;
}

export function Kbd({ children, className }: KbdProps) {
  return (
    <kbd
      className={cn(
        "px-1.5 py-0.5 rounded text-xs font-mono tabular-nums",
        "bg-daintree-border text-daintree-text/70",
        "border border-daintree-border/60",
        className
      )}
    >
      {children}
    </kbd>
  );
}

export interface KbdChordProps {
  shortcut: string;
  /** Override platform detection. Defaults to `isMac()`. */
  isMac?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * Renders a keyboard chord as per-key pills using the neutral overlay surface.
 * macOS uses glyph keys with no `+` separator; Win/Linux uses spelled-out keys
 * separated by a small `+` character. Two-step chords (`Cmd+K T`) are joined
 * by a comma+space.
 */
export function KbdChord({
  shortcut,
  isMac: isMacProp,
  className,
  "aria-label": ariaLabel,
}: KbdChordProps) {
  const mac = isMacProp ?? isMac();
  const steps = parseChord(shortcut, mac);
  if (steps.length === 0) return null;

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span className="sr-only">{ariaLabel ?? shortcut}</span>
      {steps.map((tokens, stepIndex) => (
        <Fragment key={stepIndex}>
          {stepIndex > 0 && (
            <span className="text-daintree-text/40 text-[10px] select-none" aria-hidden>
              ,
            </span>
          )}
          <span className="inline-flex items-center gap-0.5">
            {tokens.map((token, tokenIndex) => (
              <Fragment key={tokenIndex}>
                {tokenIndex > 0 && !mac && (
                  <span className="text-daintree-text/40 text-[10px] select-none" aria-hidden>
                    +
                  </span>
                )}
                <kbd
                  aria-hidden="true"
                  className={cn(
                    "px-1.5 py-0.5 rounded text-xs font-mono tabular-nums leading-none",
                    "bg-overlay-subtle text-daintree-text/70",
                    "border border-border-subtle"
                  )}
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
