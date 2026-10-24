import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AlertTriangle, X } from "lucide-react";
import type { PluginShortcutRecorderProps } from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { KbdChord } from "@/components/ui/Kbd";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  CHORD_TIMEOUT_MS,
  keybindingService,
  normalizeKeyForBinding,
} from "@/services/KeybindingService";
import { field, fn, nonEmpty, oneOf, pickRootProps, str } from "./kitProps";
import { reportPluginFault } from "./kitDiagnostics";
import { useKitFieldControl } from "./kitField";
import { pickAria, joinIds, safely, verdict, REMOVE_ROW_CLASS } from "./kitTextInputHelpers";

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "OS", "Hyper", "Super"]);
const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/;

/** The modifiers an event reports as down, in the order a combo spells them. */
function heldModifiers(event: KeyboardEvent<HTMLElement>, mac: boolean): string[] {
  const parts: string[] = [];
  if (mac && event.metaKey) parts.push("Cmd");
  // Control is its own modifier on macOS; elsewhere it is the primary one.
  if (mac && event.ctrlKey) parts.push("Ctrl");
  if (!mac && event.ctrlKey) parts.push("Cmd");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  return parts;
}

function hasCommandModifier(combo: string): boolean {
  const parts = combo.split("+");
  const key = parts[parts.length - 1] ?? "";
  if (FUNCTION_KEY.test(key)) return true;
  return parts.slice(0, -1).some((part) => part === "Cmd" || part === "Ctrl" || part === "Alt");
}

const CHORD_WINDOW_STYLE: CSSProperties & Record<"--chord-window", string> = {
  "--chord-window": `${CHORD_TIMEOUT_MS}ms`,
};

const RECORDER_FIELD =
  "flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-md)] border transition-colors duration-150 ease-out";

/** The heights of `Input`'s two densities, so a recorder lines up with the fields beside it. */
const RECORDER_DENSITY = {
  default: "min-h-[2.125rem] px-3 text-sm",
  compact: "min-h-[1.625rem] px-2 text-xs",
} as const;

function findHostConflicts(combo: string): ReturnType<typeof keybindingService.findConflicts> {
  try {
    return keybindingService.findConflicts(combo);
  } catch (error) {
    reportPluginFault("ShortcutRecorder conflict lookup failed", error);
    return [];
  }
}

function hostConflict(combo: string): string | null {
  const conflicts = findHostConflicts(combo);
  if (conflicts.length === 0) return null;
  const exact = conflicts.find((conflict) => conflict.kind !== "shadowed") ?? conflicts[0]!;
  const name = exact.description || exact.actionId;
  const more = conflicts.length > 1 ? ` and ${conflicts.length - 1} more` : "";
  return exact.kind === "shadowed"
    ? `Overlaps Daintree's shortcut for ${name}${more}`
    : `Daintree uses this for ${name}${more}; its shortcut wins`;
}

export function KitShortcutRecorder(props: PluginShortcutRecorderProps) {
  const {
    value,
    defaultValue,
    onValueChange,
    allowChords,
    requireModifier,
    validate,
    getConflict,
    checkHostConflicts,
    placeholder,
    disabled,
    density,
    className,
  } = props;
  const compact = oneOf(density, ["default", "compact"] as const) === "compact";
  const chipDensity = compact ? "compact" : "default";
  const fieldRef = useRef<HTMLDivElement>(null);
  const controlled = Object.hasOwn(props, "value");
  const [own, setOwn] = useState<string | null>(() => nonEmpty(defaultValue) ?? null);
  const combo = controlled ? (nonEmpty(value) ?? null) : own;
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState<string[]>([]);
  const [firstStep, setFirstStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusId = useId();
  const errorId = useId();
  const conflictId = useId();
  const handleValue = fn(onValueChange);
  const check = fn(validate);
  const conflictOf = fn(getConflict);
  const inert = disabled === true;
  const mac = isMac();
  // A div, which a `<label htmlFor>` cannot name: a vertical FormField names
  // it through `aria-labelledby` instead.
  const { controlProps } = useKitFieldControl(props, error ? true : undefined, false);

  // Disabled mid-recording: the recording, and any chord half-pressed, end.
  if (inert && (recording || firstStep !== null)) {
    setRecording(false);
    setFirstStep(null);
    setHeld([]);
  }

  useEffect(() => {
    if (!recording) return;
    // The app's own shortcuts stand down while a combo is being recorded.
    const release = keybindingService.beginShortcutCapture();
    // Held keys can't be seen once the window loses focus, and a chord
    // window must not finish while another app is in front: recording ends,
    // and the shortcut it had stays.
    const view = fieldRef.current?.ownerDocument.defaultView;
    const cancel = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      setFirstStep(null);
      setHeld([]);
      setRecording(false);
    };
    view?.addEventListener("blur", cancel);
    return () => {
      view?.removeEventListener("blur", cancel);
      release();
    };
  }, [recording]);

  useEffect(() => {
    if (!inert || timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, [inert]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const stopTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const setCombo = (next: string | null) => {
    if (!controlled) setOwn(next);
    safely("ShortcutRecorder onValueChange", handleValue, next);
  };
  const finish = (steps: readonly string[]) => {
    stopTimer();
    setFirstStep(null);
    setHeld([]);
    const next = steps.join(" ");
    const refused = verdict(check, next);
    if (refused) {
      setError(refused);
      return;
    }
    setError(null);
    setRecording(false);
    setCombo(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (inert || event.repeat || event.nativeEvent.isComposing) return;
    // AltGr types a character; the host's matcher never fires on it either.
    if (!mac && event.nativeEvent.getModifierState?.("AltGraph")) return;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    // Tab always moves on: a recorder that kept it would trap the keyboard.
    if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (firstStep) finish([firstStep]);
      return;
    }
    if (!recording) {
      if (plain && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        setError(null);
        setRecording(true);
      } else if (plain && (event.key === "Backspace" || event.key === "Delete") && combo) {
        event.preventDefault();
        setCombo(null);
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape" && plain) {
      stopTimer();
      setFirstStep(null);
      setHeld([]);
      setError(null);
      setRecording(false);
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && plain && !firstStep) {
      setError(null);
      setCombo(null);
      return;
    }
    const parts = heldModifiers(event, mac);
    const normalized = normalizeKeyForBinding(event.nativeEvent);
    // A letter is spelled as the app's own bindings spell it ("Cmd+K").
    const key = normalized.length === 1 ? normalized.toUpperCase() : normalized;
    if (MODIFIER_KEYS.has(key) || MODIFIER_KEYS.has(event.key)) {
      setHeld(parts);
      return;
    }
    const step = [...parts, key].join("+");
    if (!firstStep && requireModifier !== false && !hasCommandModifier(step)) {
      setHeld([]);
      setError(
        mac
          ? "Include ⌘, ⌃ or ⌥, so the shortcut doesn't type into text fields"
          : "Include Ctrl or Alt, so the shortcut doesn't type into text fields"
      );
      return;
    }
    if (firstStep) {
      finish([firstStep, step]);
      return;
    }
    if (allowChords === true) {
      setFirstStep(step);
      setHeld([]);
      setError(null);
      stopTimer();
      timerRef.current = setTimeout(() => finish([step]), CHORD_TIMEOUT_MS);
      return;
    }
    finish([step]);
  };

  // The warnings follow what is in force until a new shortcut is under way,
  // then its first step: never the shortcut it is replacing, and no line
  // that comes and goes (moving the fields below) just because the field
  // took focus.
  const shownCombo = recording && firstStep !== null ? firstStep : combo;
  const hostWarning = shownCombo && checkHostConflicts !== false ? hostConflict(shownCombo) : null;
  const ownWarning = shownCombo ? verdict(conflictOf, shownCombo, null) : null;
  const warnings = [ownWarning, hostWarning].filter((line): line is string => line !== null);
  const describedBy = joinIds([
    // Inside a FormField the field's ids already include the caller's.
    str(field(controlProps, "aria-describedby")) ?? str(props["aria-describedby"]),
    error ? errorId : undefined,
    warnings.length > 0 ? conflictId : undefined,
    statusId,
  ]);

  let content: ReactNode;
  let status: string;
  if (recording && firstStep) {
    status = "Press the second key, or wait to finish";
    content = (
      <>
        <KbdChord shortcut={firstStep} foreground="primary" density={chipDensity} />
        <span className="truncate text-xs text-text-secondary">Press second key or wait</span>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-[var(--radius-md)]"
        >
          <span
            className="absolute inset-x-0 bottom-0 h-0.5 bg-text-secondary animate-chord-window"
            style={CHORD_WINDOW_STYLE}
          />
        </span>
      </>
    );
  } else if (recording && held.length > 0) {
    status = "Now press a key";
    content = (
      <>
        <KbdChord shortcut={held.join("+")} foreground="primary" density={chipDensity} />
        <span className="truncate text-xs text-text-secondary">Now press a key</span>
      </>
    );
  } else if (recording) {
    status = "Recording. Press a shortcut, Escape to stop";
    content = (
      <span className="truncate">
        Press a shortcut
        <span className="text-text-secondary"> · Esc to stop</span>
      </span>
    );
  } else if (combo) {
    status = "";
    content = <KbdChord shortcut={combo} foreground="primary" density={chipDensity} />;
  } else {
    status = "";
    content = (
      <span className="truncate text-text-secondary">{nonEmpty(placeholder) ?? "Not set"}</span>
    );
  }

  return (
    <div {...pickRootProps(props)} className={cn("grid min-w-0 gap-1.5", str(className))}>
      <div className="flex min-w-0 items-center gap-1.5">
        <div
          {...pickAria(props)}
          {...controlProps}
          role="button"
          tabIndex={inert ? -1 : 0}
          aria-disabled={inert ? true : undefined}
          aria-pressed={recording}
          aria-describedby={describedBy}
          aria-label={
            str(props["aria-label"]) === undefined && !field(controlProps, "aria-labelledby")
              ? "Shortcut"
              : str(props["aria-label"])
          }
          data-recording={recording ? "" : undefined}
          onKeyDown={onKeyDown}
          onKeyUp={(event) => {
            if (recording && !firstStep) setHeld(heldModifiers(event, mac));
          }}
          onFocus={() => {
            if (!inert) setRecording(true);
          }}
          onClick={() => {
            if (!inert) setRecording(true);
          }}
          onBlur={() => {
            if (firstStep) finish([firstStep]);
            stopTimer();
            setHeld([]);
            setRecording(false);
          }}
          ref={fieldRef}
          className={cn(
            RECORDER_FIELD,
            RECORDER_DENSITY[compact ? "compact" : "default"],
            "relative select-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary",
            recording
              ? "border-border-strong bg-overlay-subtle text-text-primary"
              : "border-border-input bg-surface-input text-text-primary hover:border-border-strong",
            error && "border-status-error",
            inert ? "cursor-not-allowed opacity-50" : "cursor-pointer"
          )}
        >
          {content}
        </div>
        {combo && !inert ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Clear shortcut"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              // The button goes with the shortcut; a keyboard user lands on
              // the field, ready to record the next one.
              const hadFocus =
                event.currentTarget.ownerDocument.activeElement === event.currentTarget;
              stopTimer();
              setFirstStep(null);
              setHeld([]);
              setError(null);
              setCombo(null);
              if (hadFocus) fieldRef.current?.focus();
            }}
            className={REMOVE_ROW_CLASS}
          >
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <span id={statusId} role="status" aria-live="polite" className="sr-only">
        {status}
      </span>
      {error ? (
        <InlineError id={errorId} role="alert">
          {error}
        </InlineError>
      ) : null}
      {warnings.length > 0 ? (
        <div id={conflictId} className="grid gap-1">
          {warnings.map((warning) => (
            <p key={warning} className="flex items-start gap-1.5 text-xs text-text-primary">
              <AlertTriangle
                aria-hidden="true"
                className="mt-px h-3.5 w-3.5 shrink-0 text-status-warning"
              />
              <span className="min-w-0">{warning}</span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
