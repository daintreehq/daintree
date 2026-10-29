import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";
import type { PluginSecretInputProps } from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { inputVariants } from "@/components/ui/input";
import { Spinner } from "@/components/ui/Spinner";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { cn } from "@/lib/utils";
import { field, fn, nonEmpty, oneOf, pickRootProps, str } from "./kitProps";
import { faultMessage, isThenable, reportPluginFault, settleThenable } from "./kitDiagnostics";
import { invalidProp, useKitFieldControl } from "./kitField";
import { joinIds, pickAria, safely, attempt } from "./kitTextInputHelpers";

const DOTS = "••••••••";

export function KitSecretInput(props: PluginSecretInputProps) {
  const {
    value,
    defaultValue,
    onValueChange,
    stored,
    storedHint,
    onReplace,
    onCancelReplace,
    onClear,
    onSubmit,
    allowCopy,
    revealable,
    placeholder,
    name,
    disabled,
    invalid,
    autoFocus,
    density,
    className,
  } = props;
  const controlled = Object.hasOwn(props, "value");
  const [own, setOwn] = useState(() => str(defaultValue) ?? "");
  const text = controlled ? (str(value) ?? "") : own;
  const [shown, setShown] = useState(false);
  const [replacing, setReplacing] = useState(false);
  // What gets focus once the other state has mounted: the empty field after
  // Replace, or Replace again after backing out of it.
  const [focusTarget, setFocusTarget] = useState<"field" | "replace" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  // Each Replace is a session; a save still out when it ends is ignored.
  const replaceSessionRef = useRef(0);
  // The save in flight, if any: the session it belongs to. Only that save
  // may end the pending state or close the field.
  const savingRef = useRef<{ session: number } | null>(null);
  // A save that settles once the field is gone changes nothing, and calls no
  // plugin callback.
  useEffect(
    () => () => {
      savingRef.current = null;
    },
    []
  );
  const [saving, setSaving] = useState(false);
  // Why the last save failed, shown under the field until the next edit, as
  // InlineEdit does: a failed save must not look like one that went through.
  const [saveError, setSaveError] = useState<string | null>(null);
  const errorId = useId();
  // A save under 400ms shows nothing, per the app's loading gate.
  const showSaving = useDohertyGate(saving);
  const handleValue = fn(onValueChange);
  const replace = fn(onReplace);
  const cancelReplace = fn(onCancelReplace);
  const clear = fn(onClear);
  const submit = fn(onSubmit);
  const inert = disabled === true;
  const compact = oneOf(density, ["default", "compact"] as const) === "compact";
  const hint = nonEmpty(storedHint)?.slice(-6);
  const showStored = stored === true && !replacing;
  const canReveal = revealable !== false;
  // Turning `revealable` off hides a value that was showing.
  const revealed = canReveal && shown;
  const label = str(props["aria-label"]);
  const { invalid: shownInvalid, controlProps } = useKitFieldControl(props, invalidProp(invalid));
  // The saved state is a group, which a `<label for>` can't name, so it joins
  // the field through `aria-labelledby` instead.
  const { controlProps: storedControlProps } = useKitFieldControl(
    props,
    invalidProp(invalid),
    false
  );

  // A secret saved while the field was open (the save went through) shows as
  // saved again.
  const [wasStored, setWasStored] = useState(stored === true);
  if (wasStored !== (stored === true)) {
    setWasStored(stored === true);
    if (stored === true) {
      // The draft that was saved is not kept behind the saved state.
      setReplacing(false);
      setShown(false);
      setSaveError(null);
      if (!controlled) setOwn("");
    }
  }

  useLayoutEffect(() => {
    if (focusTarget === null) return;
    setFocusTarget(null);
    (focusTarget === "field" ? inputRef : replaceRef).current?.focus();
  }, [focusTarget]);

  const change = (next: string) => {
    setSaveError(null);
    if (!controlled) setOwn(next);
    safely("SecretInput onValueChange", handleValue, next);
  };
  // Every save is tracked the same way, first or replacement: a promise holds
  // the field read-only until it settles, and a throw or a rejection keeps
  // the typed value to try again. Only a replacement saved while `stored`
  // stays true (the usual case: a token swapped for a new one) then goes back
  // to the saved state on its own.
  const submitDraft = () => {
    // One save at a time: a second Enter while one is out does nothing.
    if (savingRef.current) return;
    // The plugin's reason, unless it repeats the secret: that never goes on screen.
    const failed = (reason: unknown) => {
      const message = faultMessage(reason, "Couldn't save");
      setSaveError(text !== "" && message.includes(text) ? "Couldn't save" : message);
    };
    setSaveError(null);
    const outcome = attempt(() => submit?.(text));
    if (!outcome.ok) {
      reportPluginFault("SecretInput onSubmit threw", outcome.error);
      failed(outcome.error);
      return;
    }
    const replacingStored = replacing && stored === true;
    const close = () => {
      if (!replacingStored) return;
      // Focus follows to Replace only if the user is still in the field;
      // someone who moved on while it saved keeps their place.
      const input = inputRef.current;
      const active = input?.ownerDocument.activeElement;
      const stillHere =
        !!input && (active === input || active === input.ownerDocument.body || !active);
      change("");
      setReplacing(false);
      setShown(false);
      if (stillHere) setFocusTarget("replace");
    };
    if (!isThenable(outcome.value)) {
      close();
      return;
    }
    // While it saves the field holds read-only, so the value that lands is
    // the value that was typed; Cancel stays available.
    const token = { session: replaceSessionRef.current };
    savingRef.current = token;
    setSaving(true);
    const settle = (saved: boolean, reason?: unknown) => {
      // A save that lands after the user backed out, or started another
      // replace, changes nothing in the field they are in now.
      if (savingRef.current !== token) return;
      savingRef.current = null;
      setSaving(false);
      if (replaceSessionRef.current !== token.session) return;
      if (saved) close();
      else failed(reason);
    };
    settleThenable(outcome.value).then(
      () => settle(true),
      (reason: unknown) => settle(false, reason)
    );
  };
  const backOut = () => {
    replaceSessionRef.current++;
    savingRef.current = null;
    setSaving(false);
    change("");
    setReplacing(false);
    setShown(false);
    setFocusTarget("replace");
    safely("SecretInput onCancelReplace", cancelReplace);
  };

  if (showStored) {
    return (
      <div
        {...pickRootProps(props)}
        role="group"
        aria-label={label}
        aria-labelledby={str(props["aria-labelledby"])}
        aria-describedby={str(props["aria-describedby"])}
        {...storedControlProps}
        className={cn("flex min-w-0 items-center gap-2", str(className))}
      >
        <div
          data-secret-stored=""
          className={cn(
            inputVariants({ density: compact ? "compact" : "default" }),
            "flex min-w-0 flex-1 items-center gap-2 text-text-secondary",
            inert && "opacity-50"
          )}
        >
          <Lock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="shrink-0">Saved</span>
          <span aria-hidden="true" className="min-w-0 truncate font-mono tracking-wider">
            {DOTS}
            {hint}
          </span>
          {hint ? <span className="sr-only">{`ending in ${hint}`}</span> : null}
        </div>
        <Button
          ref={replaceRef}
          type="button"
          variant="outline"
          size={compact ? "xs" : "sm"}
          disabled={inert}
          onClick={() => {
            replaceSessionRef.current++;
            savingRef.current = null;
            setSaving(false);
            change("");
            setReplacing(true);
            setShown(false);
            setFocusTarget("field");
            safely("SecretInput onReplace", replace);
          }}
        >
          Replace
        </Button>
        {clear ? (
          <Button
            type="button"
            variant="ghost-danger"
            size={compact ? "xs" : "sm"}
            disabled={inert}
            onClick={() => safely("SecretInput onClear", clear)}
          >
            Clear
          </Button>
        ) : null}
      </div>
    );
  }

  const blockCopy = allowCopy !== true;
  return (
    <div
      {...pickRootProps(props)}
      className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5", str(className))}
    >
      <div className="relative min-w-0 flex-1">
        <input
          {...pickAria(props)}
          {...controlProps}
          aria-invalid={saveError ? true : controlProps["aria-invalid"]}
          aria-describedby={joinIds([
            saveError ? errorId : undefined,
            str(field(controlProps, "aria-describedby")) ?? str(props["aria-describedby"]),
          ])}
          ref={inputRef}
          type={revealed ? "text" : "password"}
          value={text}
          name={str(name)}
          placeholder={
            str(placeholder) ??
            (replacing ? "Paste a new value to replace the saved one" : undefined)
          }
          disabled={inert}
          readOnly={saving}
          aria-busy={saving ? true : undefined}
          autoFocus={autoFocus === true}
          autoComplete="new-password"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          data-secret-revealed={revealed ? "" : undefined}
          onChange={(event) => change(event.target.value)}
          onCopy={blockCopy ? (event) => event.preventDefault() : undefined}
          onCut={blockCopy ? (event) => event.preventDefault() : undefined}
          onDragStart={blockCopy ? (event) => event.preventDefault() : undefined}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && submit) {
              event.preventDefault();
              submitDraft();
            } else if (event.key === "Escape" && replacing) {
              event.preventDefault();
              event.stopPropagation();
              backOut();
            }
          }}
          className={cn(
            inputVariants({
              density: compact ? "compact" : "default",
              invalid: shownInvalid || saveError !== null,
            }),
            "font-mono placeholder:font-sans",
            canReveal && (compact ? "pr-8" : "pr-9")
          )}
        />
        {canReveal ? (
          // A glyph inside the field, not a Button: the pressed Button's
          // ring and fill drew a second box against the field's own edge.
          // The eye itself says which state it is in, and 24px is the
          // target floor.
          <button
            type="button"
            disabled={inert}
            aria-label="Show value"
            aria-pressed={revealed}
            // The field keeps focus, so a blur-to-save around it never fires.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setShown((open) => !open)}
            className={cn(
              "absolute top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary transition-colors duration-150 ease-out hover:bg-overlay-hover hover:text-text-primary focus-visible:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary disabled:pointer-events-none [&_svg]:size-3.5",
              compact ? "right-px" : "right-1"
            )}
          >
            {revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </button>
        ) : null}
      </div>
      {showSaving ? <Spinner size="xs" className="shrink-0 text-text-secondary" /> : null}
      {replacing ? (
        <Button
          type="button"
          variant="ghost"
          size={compact ? "xs" : "sm"}
          disabled={inert}
          onClick={backOut}
        >
          Cancel
        </Button>
      ) : null}
      {saveError ? (
        <InlineError id={errorId} role="alert" className="basis-full">
          {saveError}
        </InlineError>
      ) : null}
    </div>
  );
}
