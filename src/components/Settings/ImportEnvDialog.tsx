import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { AppDialog, type RestoreFocusTarget } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Textarea } from "@/components/ui/textarea";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { cn } from "@/lib/utils";
import { parseEnvPaste, type ParseEnvResult } from "@/utils/parseEnvPaste";
import { isSecretEnvEntry, maskSecretValue } from "@/utils/secretDetection";

type ConflictResolution = "keep" | "overwrite";
type Step = "paste" | "conflicts";

interface Conflict {
  key: string;
  oldValue: string;
  newValue: string;
}

interface ImportEnvDialogProps {
  isOpen: boolean;
  onClose: () => void;
  env: Record<string, string>;
  onImport: (merged: Record<string, string>) => void;
  /** Where focus goes on close if the button that opened the dialog is gone by then. */
  restoreFocusTo?: RestoreFocusTarget;
}

/**
 * Named stages, so the dialog answers "where am I" without a stepper. Two
 * conditional steps do not warrant one, and the second step only exists when
 * something collides — a "Step 1 of 2" counter would be a lie on every clean
 * import. Matches the step heading `AgentSetupWizard` owns, minus its counter.
 */
const STEP_TITLE: Record<Step, string> = {
  paste: "Paste variables",
  conflicts: "Resolve conflicts",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The merge policy restated where the evidence is, as what the import will
 * actually do. Without it the conflict list shows the same old/new pair under
 * both policies, which reads as "all of these are about to change" even when
 * "Keep existing" means none of them are — and naming the additions here keeps
 * the other half of the import in view at the point of commitment.
 */
function outcomeLabel(mode: ConflictResolution, conflictCount: number, newCount: number): string {
  const existing = `${mode === "keep" ? "keeps" : "replaces"} ${plural(conflictCount, "existing value")}`;
  return newCount > 0 ? `Adds ${newCount} new · ${existing}` : `No new keys · ${existing}`;
}

/**
 * A rejected line echoed back under its error is still pasted text, and a
 * malformed secret is still a secret — mask its value the way the comparison
 * rows do. The key stays readable because the key is usually what is wrong.
 */
function redactRaw(raw: string): string {
  const eq = raw.indexOf("=");
  if (eq === -1) return raw;
  const head = raw.slice(0, eq + 1);
  const value = raw.slice(eq + 1).trim();
  const bare = value.replace(/^["']|["']$/g, "");
  const key = head
    .replace(/^\s*export\s+/, "")
    .slice(0, -1)
    .trim();
  return isSecretEnvEntry(key, bare) ? `${head}${maskSecretValue(bare)}` : raw;
}

/**
 * Character offsets of a 1-based line in the paste, for selecting it. Split on
 * LF alone: a textarea's value has its newlines normalized to LF, so a CRLF
 * paste arrives here without its CRs and the offsets match the field.
 */
function lineRange(text: string, line: number): [number, number] {
  const lines = text.split("\n");
  let start = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) start += lines[i]!.length + 1;
  return [start, start + (lines[line - 1]?.length ?? 0)];
}

/** The caption-strip recipe shared by the app's other destructive previews. */
const PREVIEW_FRAME = "rounded-[var(--radius-md)] border border-tint/[0.08] bg-tint/[0.04] text-xs";
const PREVIEW_STRIP =
  "px-3 py-2 border-b border-tint/[0.08] flex items-center justify-between gap-2";
const PREVIEW_CAPTION = "text-2xs font-semibold uppercase tracking-wider text-text-secondary";
const PREVIEW_COUNT =
  "ml-1.5 tabular-nums bg-tint/10 rounded-[var(--radius-sm)] px-1 py-0.5 text-3xs font-medium normal-case tracking-normal";

function collapsePairs(result: ParseEnvResult): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of result.pairs) out[p.key] = p.value; // later duplicates win
  return out;
}

interface Classified {
  conflicts: Conflict[];
  /** Keys the env does not have yet. */
  newCount: number;
  /** Keys the env already holds with exactly this value — importing them changes nothing. */
  unchangedCount: number;
}

function classify(env: Record<string, string>, incoming: Record<string, string>): Classified {
  const conflicts: Conflict[] = [];
  let newCount = 0;
  let unchangedCount = 0;
  for (const [key, newValue] of Object.entries(incoming)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) newCount++;
    else if (env[key] === newValue) unchangedCount++;
    else conflicts.push({ key, oldValue: env[key] ?? "", newValue });
  }
  return { conflicts, newCount, unchangedCount };
}

function buildMerged(
  env: Record<string, string>,
  incoming: Record<string, string>,
  mode: ConflictResolution
): Record<string, string> {
  if (mode === "overwrite") {
    return { ...env, ...incoming };
  }
  // keep existing — only add keys not present.
  const merged = { ...env };
  for (const [key, value] of Object.entries(incoming)) {
    if (!Object.prototype.hasOwnProperty.call(merged, key)) merged[key] = value;
  }
  return merged;
}

/**
 * One side of a conflict.
 *
 * The side that survives carries the readable tier and the other the secondary
 * one, so the two merge modes no longer render identically — but the weight is
 * the redundant cue, not the load-bearing one. What actually names each side is
 * the `<dt>`, because a difference carried by colour, weight, or a strikethrough
 * alone does not survive `forced-colors: active` and is not announced at all
 * (WCAG 1.4.1, 1.3.1). `(empty)` is italicised so a value being blanked cannot
 * be mistaken for a value named "(empty)".
 */
function ConflictSide({
  label,
  value,
  kept,
  masked,
}: {
  label: string;
  value: string;
  kept: boolean;
  masked: boolean;
}) {
  const isEmpty = value === "";
  return (
    <>
      <dt className="text-3xs uppercase tracking-wide text-text-secondary">{label}</dt>
      <dd
        className={cn(
          // BOTH sides read at the audited 4.5:1 tier. The losing value is
          // still evidence the user has to inspect — dimming it made the half
          // being protected the hardest thing in the row to read. The surviving
          // side is marked by weight instead, which costs no contrast and
          // survives forced-colors, where a colour difference would not.
          "font-mono text-2xs break-all text-text-primary",
          kept ? "font-medium" : "font-normal",
          isEmpty && "italic"
        )}
      >
        {isEmpty ? (
          "(empty)"
        ) : masked ? (
          <>
            <span aria-hidden="true">{maskSecretValue(value)}</span>
            <span className="sr-only">Hidden</span>
          </>
        ) : (
          value
        )}
      </dd>
    </>
  );
}

export function ImportEnvDialog({
  isOpen,
  onClose,
  env,
  onImport,
  restoreFocusTo,
}: ImportEnvDialogProps) {
  const [pastedText, setPastedText] = useState("");
  const [step, setStep] = useState<Step>("paste");
  const [conflictResolution, setConflictResolution] = useState<ConflictResolution>("keep");
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());

  const headingId = useId();
  const helpId = useId();
  const errorSummaryId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const prevStepRef = useRef<Step>("paste");

  // Single reset effect keyed on [isOpen] — avoids the split-effect trap from #4958.
  useEffect(() => {
    if (isOpen) {
      setPastedText("");
      setStep("paste");
      setConflictResolution("keep");
      setRevealed(new Set());
      prevStepRef.current = "paste";
    }
  }, [isOpen]);

  // The dialog is opened to be pasted into, so the caret starts in the textarea
  // rather than on the header close button `initialFocus: "first"` would pick.
  // `initialFocus="none"` hands the whole job over — the same arrangement
  // `AgentSetupWizard` uses — so there is no race between two focus calls.
  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  /**
   * Move focus deliberately on a step change, rather than leaving it on the
   * footer button whose label just changed underneath it (WAI-ARIA APG, dialog
   * pattern).
   *
   * Forward lands on the step heading: the conflict step is new information and
   * a decision, so it gets announced before the controls. Back lands on the
   * textarea instead — that step is already known and the reason for returning
   * is to edit the paste.
   */
  useEffect(() => {
    if (!isOpen || prevStepRef.current === step) return;
    prevStepRef.current = step;
    const frame = requestAnimationFrame(() => {
      if (step === "conflicts") stepHeadingRef.current?.focus();
      else textareaRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, step]);

  const parsed = useMemo(() => parseEnvPaste(pastedText), [pastedText]);
  const incoming = useMemo(() => collapsePairs(parsed), [parsed]);
  const { conflicts, newCount, unchangedCount } = useMemo(
    () => classify(env, incoming),
    [env, incoming]
  );

  const incomingCount = Object.keys(incoming).length;
  const hasErrors = parsed.errors.length > 0;
  // A paste of values that are all already set would "import" nothing, so the
  // button that says it will must not be pressable.
  const changesSomething = newCount > 0 || conflicts.length > 0;
  const canProceed = !hasErrors && changesSomething;
  // Keeping every existing value when nothing is new is a cancel that looks
  // like a success: the dialog would close having changed nothing.
  const keepIsNoOp = step === "conflicts" && conflictResolution === "keep" && newCount === 0;
  const canCommit = step === "conflicts" ? !keepIsNoOp : canProceed;
  const duplicateInPasteCount = parsed.pairs.length - incomingCount;

  const toggleReveal = (key: string) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** Put the caret on the offending line, selected, so the fix is one keystroke away. */
  const goToLine = (line: number) => {
    const el = textareaRef.current;
    if (!el) return;
    const [start, end] = lineRange(pastedText, line);
    el.focus();
    el.setSelectionRange(start, end);
  };

  const handleImport = (mode: ConflictResolution) => {
    onImport(buildMerged(env, incoming, mode));
    onClose();
  };

  const handlePrimary = () => {
    if (!canCommit) return;
    if (step === "paste") {
      if (conflicts.length > 0) {
        setStep("conflicts");
        return;
      }
      handleImport("overwrite");
      return;
    }
    handleImport(conflictResolution);
  };

  /**
   * The label names what pressing it will do — which means it must not name a
   * count while the button cannot be pressed. A disabled "Import 1 variable"
   * reads as an offer to import the lines that did parse and skip the rest,
   * which is not what happens.
   */
  const primaryLabel =
    step === "conflicts"
      ? conflictResolution === "keep"
        ? "Import, keep existing"
        : "Import, overwrite conflicts"
      : !canProceed
        ? "Import"
        : conflicts.length > 0
          ? `Review ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`
          : `Import ${plural(newCount, "variable")}`;

  /** Why the primary action is dead. A disabled button that explains nothing is a dead end. */
  const blockedHint = keepIsNoOp
    ? "No new keys to add"
    : step !== "paste" || canProceed
      ? null
      : hasErrors
        ? `Fix ${plural(parsed.errors.length, "parse error")} to continue`
        : incomingCount > 0
          ? "Every variable in that paste is already set"
          : pastedText.trim() !== ""
            ? "No variables found in that paste"
            : null;

  const secondaryLabel = step === "conflicts" ? "Back" : "Cancel";
  const handleSecondary = () => {
    if (step === "conflicts") {
      setRevealed(new Set());
      setStep("paste");
      return;
    }
    onClose();
  };

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      zIndex="nested"
      initialFocus="none"
      restoreFocusTo={restoreFocusTo}
      data-testid="import-env-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title>Import .env</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body className={step === "conflicts" ? "space-y-3" : "space-y-4"}>
        <div className="space-y-1">
          <h3
            ref={stepHeadingRef}
            id={headingId}
            tabIndex={-1}
            className="text-sm font-medium text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2 rounded-xs"
            data-testid="import-env-step-heading"
          >
            {STEP_TITLE[step]}
          </h3>
          <AppDialog.Description>
            {step === "paste" ? (
              // Its own id so the field can point at it: the dialog's
              // description is announced with the dialog, not with the field
              // a user comes back to after reading an error.
              <span id={helpId}>
                Paste one <code className="text-2xs">KEY=value</code> per line. Quotes, comments,
                and <code className="text-2xs">export</code> are supported.
              </span>
            ) : (
              <>
                {plural(conflicts.length, "key")} already exist
                {conflicts.length === 1 ? "s" : ""} with a different value. Choose which one wins.
              </>
            )}
          </AppDialog.Description>
        </div>

        {step === "paste" ? (
          <>
            <div className="space-y-2">
              <Textarea
                ref={textareaRef}
                variant="code"
                // Tall enough for a typical .env at a glance, short enough that
                // a handful of parse problems and the summary still fit above
                // the footer. It resizes when a paste is longer than that.
                className="h-40 leading-[inherit]"
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                placeholder={'FOO=bar\nexport BAZ="hello world"\n# comments supported'}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                // Named by the heading above it, so the name a voice-control
                // user reads off the screen is the name that reaches the field.
                aria-labelledby={headingId}
                invalid={hasErrors}
                aria-invalid={hasErrors || undefined}
                aria-describedby={hasErrors ? `${errorSummaryId} ${helpId}` : helpId}
                data-testid="import-env-textarea"
              />
              {/* Directly under the field, ahead of any errors: it is the
                  answer to "did that work", and it is shown alongside parse
                  errors too — gating it on a clean parse meant a paste with a
                  bad line and a duplicated key reported the bad line and
                  silently dropped the duplicate. */}
              {incomingCount > 0 && (
                <p className="text-xs text-text-secondary" data-testid="import-env-summary">
                  {plural(incomingCount, "variable")} detected
                  {newCount > 0 && newCount !== incomingCount ? ` · ${newCount} new` : ""}
                  {conflicts.length > 0 ? ` · ${plural(conflicts.length, "conflict")}` : ""}
                  {unchangedCount > 0 ? ` · ${unchangedCount} already set` : ""}
                  {conflicts.length === 0 && newCount > 0 ? " · existing values unchanged" : ""}
                  {duplicateInPasteCount > 0 ? (
                    <span className="text-text-primary">
                      {" "}
                      · {plural(duplicateInPasteCount, "duplicate key")} in paste (last value kept)
                    </span>
                  ) : null}
                </p>
              )}
            </div>
            {hasErrors && (
              // The shared error banner, not a live region: it re-renders on
              // every keystroke, and an alert would interrupt the user
              // mid-word while they repair the very line it describes. The
              // field's aria-invalid and its describedby link to this are what
              // announce it, on focus — the same contract as `FieldError`.
              <div data-testid="import-env-errors">
                {/* What the field is described by: the count and the first
                    problem, not the whole interactive list — landing back in
                    the field from a Line link would otherwise read every
                    reason, fix and pasted line again. */}
                <span
                  id={errorSummaryId}
                  className="sr-only"
                  data-testid="import-env-error-summary"
                >
                  {plural(parsed.errors.length, "parse error")}. Line {parsed.errors[0]!.line}:{" "}
                  {parsed.errors[0]!.reason}.
                </span>
                <InlineStatusBanner
                  severity="error"
                  role="status"
                  ariaLive="off"
                  animated={false}
                  className="rounded-[var(--radius-md)]"
                  title={`${plural(parsed.errors.length, "parse error")}`}
                  descriptionExtras={
                    <ul className="mt-1.5 space-y-1.5 text-xs">
                      {parsed.errors.map((e) => (
                        <li key={`${e.line}-${e.raw}`}>
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            {/* The line number is the way to the line: it
                                selects it in the field, so the fix is typed
                                over the problem rather than hunted for. */}
                            <button
                              type="button"
                              onClick={() => goToLine(e.line)}
                              aria-label={`Go to line ${e.line}`}
                              className="shrink-0 rounded-xs font-mono text-2xs text-text-secondary underline decoration-dotted underline-offset-2 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-1"
                            >
                              Line {e.line}
                            </button>
                            <span className="font-medium text-text-primary">{e.reason}</span>
                            {e.fix && <span className="text-text-secondary">{e.fix}</span>}
                          </div>
                          {/* The raw line on its own row: it is arbitrary
                              pasted text, and reasons like `Invalid key
                              "2BAD_KEY"` already end in a quoted piece of it,
                              so inline it reads as a continuation. */}
                          {e.raw.trim() !== "" && (
                            <div className="mt-0.5 break-all font-mono text-2xs text-text-secondary">
                              {redactRaw(e.raw)}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  }
                />
              </div>
            )}
          </>
        ) : (
          <>
            <RadioChoiceGroup legend="Conflict resolution" legendHidden>
              <RadioChoiceRow
                name="import-env-conflict-mode"
                value="keep"
                checked={conflictResolution === "keep"}
                onChange={() => setConflictResolution("keep")}
                label="Keep existing"
                description="Only add new keys — leave colliding values untouched"
                testId="import-env-mode-keep"
              />
              <RadioChoiceRow
                name="import-env-conflict-mode"
                value="overwrite"
                checked={conflictResolution === "overwrite"}
                onChange={() => setConflictResolution("overwrite")}
                label="Overwrite conflicts"
                description="Replace colliding values with the pasted ones"
                testId="import-env-mode-overwrite"
              />
            </RadioChoiceGroup>
            <div className={PREVIEW_FRAME} data-testid="import-env-conflict-list">
              <div className={PREVIEW_STRIP}>
                {/* The count sits in its own inline pill, so name computation
                    would run the two text nodes together as "Conflicts2" —
                    the gap is CSS margin, and margins are not text. The label
                    stays first so voice control still matches what is shown. */}
                <span
                  role="heading"
                  aria-level={4}
                  aria-label={`Conflicts ${conflicts.length}`}
                  className={PREVIEW_CAPTION}
                >
                  Conflicts
                  <span className={PREVIEW_COUNT}>{conflicts.length}</span>
                </span>
                <span className="text-2xs text-text-secondary" data-testid="import-env-outcome">
                  {outcomeLabel(conflictResolution, conflicts.length, newCount)}
                </span>
              </div>
              {/* Bounded and scrolled inside itself so the footer never moves,
                  but with the fade the plain `overflow-y-auto` never had: at
                  `max-h` the list rendered four of five conflicts and its own
                  clean bottom border, so a destructive preview looked complete
                  while hiding part of what it was previewing. `tabIndex`
                  + `role="region"` make the hidden part reachable by keyboard.  */}
              <ScrollShadow
                className="max-h-[224px]"
                scrollClassName="scroll-py-8"
                tabIndex={0}
                role="region"
                aria-label={`Conflicting keys — ${outcomeLabel(conflictResolution, conflicts.length, newCount).toLowerCase()}`}
                data-testid="import-env-conflict-scroller"
              >
                <ul className="divide-y divide-tint/[0.06]">
                  {conflicts.map((c) => {
                    const secret = isSecretEnvEntry(c.key, c.oldValue, c.newValue);
                    const masked = secret && !revealed.has(c.key);
                    return (
                      <li key={c.key} className="px-3 py-2">
                        <div className="flex min-h-5 items-center justify-between gap-2">
                          <span className="min-w-0 break-all font-mono text-2xs text-text-primary">
                            {c.key}
                          </span>
                          {/* Masked like the editor this imports into: a review
                            step is exactly when a screen is being shared. One
                            toggle per row, because the comparison needs both
                            sides at once. */}
                          {secret && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              className="-my-1 shrink-0"
                              onClick={() => toggleReveal(c.key)}
                              aria-pressed={!masked}
                              aria-label={`Show values of ${c.key}`}
                              data-testid="import-env-reveal"
                            >
                              {masked ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
                            </Button>
                          )}
                        </div>
                        <dl className="mt-0.5 grid grid-cols-[max-content_1fr] items-baseline gap-x-3 gap-y-0.5">
                          <ConflictSide
                            label="Existing"
                            value={c.oldValue}
                            kept={conflictResolution === "keep"}
                            masked={masked}
                          />
                          <ConflictSide
                            label="Incoming"
                            value={c.newValue}
                            kept={conflictResolution === "overwrite"}
                            masked={masked}
                          />
                        </dl>
                      </li>
                    );
                  })}
                </ul>
              </ScrollShadow>
            </div>
          </>
        )}
      </AppDialog.Body>

      <AppDialog.Footer
        hint={blockedHint}
        secondaryAction={{ label: secondaryLabel, onClick: handleSecondary }}
        primaryAction={{
          label: primaryLabel,
          onClick: handlePrimary,
          disabled: !canCommit,
        }}
      />
    </AppDialog>
  );
}
