import type { MouseEvent } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Marks the element whose control a keyboard reset hands focus back to. */
const SETTINGS_RESET_SCOPE_ATTR = "data-settings-reset-scope";

// Most specific first: the choice a radio group now holds, then the setting's
// own field, then whatever the group has left tabbable. A bare `button` query
// would land on the first radio whether or not it is the chosen one.
const RESTORE_TARGETS = [
  '[role="radio"][aria-checked="true"]',
  'input, textarea, select, [role="switch"], [role="checkbox"], [role="combobox"]',
  '[role="radio"][tabindex="0"]',
  "button",
];

const RESTORE_WAIT_FRAMES = 10;

function isEnabled(el: HTMLElement): boolean {
  return !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true";
}

function findRestoreTarget(scope: HTMLElement): HTMLElement | undefined {
  for (const selector of RESTORE_TARGETS) {
    const match = Array.from(scope.querySelectorAll<HTMLElement>(selector)).find(isEnabled);
    if (match) return match;
  }
  return undefined;
}

interface SettingsResetButtonProps {
  /** The accessible name, "Reset <setting> to default". */
  label: string;
  onReset: () => void;
  className?: string;
  "data-testid"?: string;
}

/**
 * The one reset-to-default affordance for a modified setting, in a group row or
 * the legacy grid layout alike.
 *
 * Always visible while it renders: it only renders while the value is modified,
 * which the row's modified mark is already flagging, and a hover-only reveal hid
 * it from keyboard users and from anyone scanning the page for what they changed.
 *
 * A 24px target (WCAG 2.5.8). The negative block margin keeps the label line and
 * the rail at their own height, so a row does not grow when it becomes modified.
 *
 * Resetting unmounts the button. A keyboard user would then be dropped on
 * `<body>`, so focus moves to the setting's own control in the enclosing reset
 * scope instead. A pointer reset leaves focus alone.
 */
export function SettingsResetButton({
  label,
  onReset,
  className,
  "data-testid": testId,
}: SettingsResetButtonProps) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const button = e.currentTarget;
    const fromKeyboard = e.detail === 0;
    const scope = button.closest<HTMLElement>(`[${SETTINGS_RESET_SCOPE_ATTR}]`);
    onReset();
    if (!fromKeyboard || !scope) return;
    // A reset that goes through a store can land a frame or two later, so wait
    // briefly for the button to actually leave before deciding where focus goes.
    const settle = (framesLeft: number) => {
      requestAnimationFrame(() => {
        if (button.isConnected) {
          if (framesLeft > 0) settle(framesLeft - 1);
          return;
        }
        const active = document.activeElement;
        if (active && active !== document.body) return;
        findRestoreTarget(scope)?.focus();
      });
    };
    settle(RESTORE_WAIT_FRAMES);
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      data-testid={testId}
      data-settings-reset=""
      className={cn("-my-1 shrink-0", className)}
      onClick={handleClick}
    >
      <RotateCcw aria-hidden="true" />
    </Button>
  );
}
