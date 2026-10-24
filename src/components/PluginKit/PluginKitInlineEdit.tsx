import { useId, useLayoutEffect, useRef, useState } from "react";
import type { PluginInlineEditProps } from "@shared/types/plugin-sdk-react";
import {
  inlineRenameFieldClassName,
  inlineRenameFieldInputProps,
} from "@/components/Panel/inlineRenameField";
import { InlineError } from "@/components/ui/field";
import { Spinner } from "@/components/ui/Spinner";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { cn } from "@/lib/utils";
import { fn, nonEmpty, oneOf, pickRootProps, str, wholeLimit } from "./kitProps";
import { isThenable, settleThenable, faultMessage } from "./kitDiagnostics";
import { safely, attempt, verdict } from "./kitTextInputHelpers";

const INLINE_SIZE = {
  sm: { text: "text-xs font-medium", box: "h-6 leading-6" },
  md: { text: "text-sm font-medium", box: "h-7 leading-7" },
  lg: { text: "text-base font-semibold", box: "h-8 leading-8" },
} as const;

function selectForEdit(input: HTMLInputElement, mode: "all" | "stem" | "end"): void {
  const length = input.value.length;
  if (mode === "end") {
    input.setSelectionRange(length, length);
    return;
  }
  if (mode === "stem") {
    const dot = input.value.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : length);
    return;
  }
  input.select();
}

export function KitInlineEdit(props: PluginInlineEditProps) {
  const {
    value,
    onCommit,
    validate,
    allowEmpty,
    placeholder,
    blurAction,
    activation,
    selectOnEdit,
    editing,
    onEditingChange,
    maxLength,
    disabled,
    size,
    className,
  } = props;
  const current = str(value) ?? "";
  const controlled = typeof editing === "boolean";
  const [ownEditing, setOwnEditing] = useState(false);
  const isEditing = (controlled ? editing : ownEditing) && disabled !== true;
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const showPending = useDohertyGate(pending);
  const [wasEditing, setWasEditing] = useState(isEditing);
  // Each edit is its own session: a commit still out when it ends (a
  // controlled close, a re-open) must not settle the next one.
  const [generation, setGeneration] = useState(0);
  const generationRef = useRef(0);
  // Set while plugin code runs, so a blur it causes cannot commit twice.
  const submittingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const displayRef = useRef<HTMLSpanElement>(null);
  // Focus goes back to the text only when the keyboard ended the edit; a
  // blur has already put it somewhere the user chose.
  const refocusRef = useRef(false);
  const errorId = useId();
  const commit = fn(onCommit);
  const check = fn(validate);
  const changeEditing = fn(onEditingChange);
  const label = nonEmpty(props["aria-label"]) ?? "Name";
  const shown = current === "" ? str(placeholder) : current;
  const sizing = INLINE_SIZE[oneOf(size, ["sm", "md", "lg"] as const) ?? "sm"];
  const mode = oneOf(selectOnEdit, ["all", "stem", "end"] as const) ?? "all";
  const onDouble = activation === "doubleClick";
  const cancelOnBlur = blurAction === "cancel";
  const limit = wholeLimit(maxLength, 10_000);

  // A controlled edit that starts from outside still begins from the value.
  if (wasEditing !== isEditing) {
    setWasEditing(isEditing);
    setGeneration((n) => n + 1);
    setPending(false);
    if (isEditing) {
      setDraft(current);
      setError(null);
    }
  }

  useLayoutEffect(() => {
    generationRef.current = generation;
  }, [generation]);

  useLayoutEffect(() => {
    if (isEditing) {
      const input = inputRef.current;
      if (input) {
        input.focus();
        selectForEdit(input, mode);
      }
    } else if (refocusRef.current) {
      refocusRef.current = false;
      displayRef.current?.focus();
    }
  }, [isEditing, mode]);

  const setEditing = (next: boolean) => {
    if (!controlled) setOwnEditing(next);
    safely("InlineEdit onEditingChange", changeEditing, next);
  };
  const begin = () => {
    if (disabled === true || isEditing) return;
    setDraft(current);
    setError(null);
    setEditing(true);
  };
  const finish = (refocus: boolean) => {
    refocusRef.current = refocus;
    setError(null);
    setPending(false);
    setEditing(false);
  };
  const submit = (fromBlur: boolean) => {
    if (pending || submittingRef.current) return;
    const next = draft.trim();
    if (next === current) {
      finish(!fromBlur);
      return;
    }
    if (next === "" && allowEmpty !== true) {
      // Leaving an emptied field puts the name back, as the pane title does.
      if (fromBlur) finish(false);
      else setError("Enter a name");
      return;
    }
    const refused = verdict(check, next);
    if (refused) {
      setError(refused);
      return;
    }
    if (!commit) {
      finish(!fromBlur);
      return;
    }
    submittingRef.current = true;
    const outcome = attempt(() => commit(next));
    submittingRef.current = false;
    if (!outcome.ok) {
      setError(faultMessage(outcome.error, "Couldn't rename"));
      return;
    }
    if (!isThenable(outcome.value)) {
      finish(!fromBlur);
      return;
    }
    setPending(true);
    setError(null);
    const started = generation;
    const stillHere = () => {
      const input = inputRef.current;
      const active = input?.ownerDocument.activeElement;
      return !!input && (active === input || active === input.ownerDocument.body || !active);
    };
    settleThenable(outcome.value).then(
      () => {
        // Focus goes back to the text only if the user is still here;
        // someone who tabbed on while it saved keeps their place.
        if (generationRef.current === started) finish(!fromBlur && stillHere());
      },
      (reason: unknown) => {
        if (generationRef.current !== started) return;
        setPending(false);
        setError(faultMessage(reason, "Couldn't rename"));
        if (stillHere()) inputRef.current?.focus();
      }
    );
  };
  const cancel = (refocus: boolean) => {
    if (pending) return;
    finish(refocus);
  };

  if (!isEditing) {
    return (
      <span
        {...pickRootProps(props)}
        ref={displayRef}
        role="button"
        tabIndex={disabled === true ? -1 : 0}
        aria-disabled={disabled === true ? true : undefined}
        aria-label={`${label}: ${shown ?? "empty"}`}
        aria-keyshortcuts="F2"
        onClick={onDouble ? undefined : begin}
        onDoubleClick={onDouble ? begin : undefined}
        onKeyDown={(event) => {
          // A button's keys (Enter, Space) plus F2, the rename key. Space is
          // taken on keydown so it neither scrolls the pane nor types itself
          // into the field it opens.
          if (event.key === "F2" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            begin();
          }
        }}
        className={cn(
          // No negative margin: it would take 8px off the width the text
          // claims from its container, and a `truncate` title (a PaneHeader's)
          // would then clip it with room to spare. The text, the sizer and
          // the field below all share one box, so nothing shifts on edit.
          "inline-block max-w-full min-w-0 truncate rounded-sm border border-transparent px-1 align-middle transition-colors duration-150 ease-out",
          sizing.text,
          sizing.box,
          current === "" ? "text-text-secondary" : "text-text-primary",
          disabled === true
            ? "cursor-default opacity-50"
            : "cursor-text hover:bg-overlay-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2",
          str(className)
        )}
      >
        {shown ?? " "}
      </span>
    );
  }

  return (
    <span
      {...pickRootProps(props)}
      className={cn("inline-flex max-w-full min-w-0 flex-col items-start gap-1", str(className))}
    >
      <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
        <span className="inline-grid max-w-full min-w-0">
          <span
            aria-hidden="true"
            className={cn(
              "invisible col-start-1 row-start-1 block min-w-[6ch] truncate whitespace-pre border border-transparent px-1",
              sizing.text,
              sizing.box
            )}
          >
            {draft === "" ? (str(placeholder) ?? " ") : draft}
          </span>
          <input
            {...inlineRenameFieldInputProps}
            ref={inputRef}
            // No intrinsic width of its own: the sizer text sets the box, as
            // in the pane title's rename.
            size={1}
            value={draft}
            maxLength={limit}
            readOnly={pending}
            placeholder={str(placeholder)}
            aria-label={label}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            aria-busy={pending ? true : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                submit(false);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancel(true);
              }
            }}
            onBlur={() => {
              if (pending) return;
              if (cancelOnBlur) cancel(false);
              else submit(true);
            }}
            className={cn(
              inlineRenameFieldClassName,
              "col-start-1 row-start-1 w-full min-w-0",
              sizing.text,
              sizing.box,
              error && "border-status-error focus-visible:border-status-error"
            )}
          />
        </span>
        {showPending ? <Spinner size="xs" className="shrink-0 text-text-secondary" /> : null}
      </span>
      {error ? (
        <InlineError id={errorId} as="span">
          {error}
        </InlineError>
      ) : null}
    </span>
  );
}
