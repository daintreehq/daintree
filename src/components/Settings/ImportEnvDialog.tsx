import { useEffect, useId, useMemo, useRef, useState } from "react";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { AlertTriangle } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { cn } from "@/lib/utils";
import { parseEnvPaste, type ParseEnvResult } from "@/utils/parseEnvPaste";

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

/**
 * The merge policy restated where the evidence is. Without it the conflict list
 * shows the same old/new pair under both policies, which reads as "all of these
 * are about to change" even when "Keep existing" means none of them are.
 */
const OUTCOME_LABEL: Record<ConflictResolution, string> = {
  keep: "Existing values kept",
  overwrite: "Incoming values applied",
};

/** The caption-strip recipe shared by the app's other destructive previews. */
const PREVIEW_FRAME = "rounded border border-tint/[0.08] bg-tint/[0.04] text-xs";
const PREVIEW_STRIP =
  "px-3 py-2 border-b border-tint/[0.08] flex items-center justify-between gap-2";
const PREVIEW_CAPTION = "text-2xs font-semibold uppercase tracking-wider text-text-secondary";
const PREVIEW_COUNT =
  "ml-1.5 tabular-nums bg-tint/10 rounded px-1 py-0.5 text-3xs font-medium normal-case tracking-normal";

function collapsePairs(result: ParseEnvResult): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of result.pairs) out[p.key] = p.value; // later duplicates win
  return out;
}

function findConflicts(env: Record<string, string>, incoming: Record<string, string>): Conflict[] {
  const out: Conflict[] = [];
  for (const [key, newValue] of Object.entries(incoming)) {
    if (Object.prototype.hasOwnProperty.call(env, key) && env[key] !== newValue) {
      out.push({ key, oldValue: env[key] ?? "", newValue });
    }
  }
  return out;
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
function ConflictSide({ label, value, kept }: { label: string; value: string; kept: boolean }) {
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
        {isEmpty ? "(empty)" : value}
      </dd>
    </>
  );
}

export function ImportEnvDialog({ isOpen, onClose, env, onImport }: ImportEnvDialogProps) {
  const [pastedText, setPastedText] = useState("");
  const [step, setStep] = useState<Step>("paste");
  const [conflictResolution, setConflictResolution] = useState<ConflictResolution>("keep");

  const errorsId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const prevStepRef = useRef<Step>("paste");

  // Single reset effect keyed on [isOpen] — avoids the split-effect trap from #4958.
  useEffect(() => {
    if (isOpen) {
      setPastedText("");
      setStep("paste");
      setConflictResolution("keep");
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
  const conflicts = useMemo(() => findConflicts(env, incoming), [env, incoming]);

  const incomingCount = Object.keys(incoming).length;
  const newCount = incomingCount - conflicts.length;
  const hasErrors = parsed.errors.length > 0;
  const canProceed = !hasErrors && incomingCount > 0;
  const duplicateInPasteCount = parsed.pairs.length - incomingCount;

  const handleImport = (mode: ConflictResolution) => {
    onImport(buildMerged(env, incoming, mode));
    onClose();
  };

  const handlePrimary = () => {
    if (!canProceed) return;
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
          : `Import ${incomingCount} variable${incomingCount === 1 ? "" : "s"}`;

  /** Why the primary action is dead. A disabled button that explains nothing is a dead end. */
  const blockedHint =
    step !== "paste" || canProceed
      ? null
      : hasErrors
        ? `Fix ${parsed.errors.length} parse error${parsed.errors.length === 1 ? "" : "s"} to continue`
        : pastedText.trim() !== ""
          ? "No variables found in that paste"
          : null;

  const secondaryLabel = step === "conflicts" ? "Back" : "Cancel";
  const handleSecondary = () => {
    if (step === "conflicts") {
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
            tabIndex={-1}
            className="text-sm font-medium text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2 rounded-xs"
            data-testid="import-env-step-heading"
          >
            {STEP_TITLE[step]}
          </h3>
          <AppDialog.Description>
            {step === "paste" ? (
              <>
                Keys must match <code className="text-2xs">[A-Za-z_][A-Za-z0-9_]*</code>. Quoted
                values, comments, and <code className="text-2xs">export</code> prefixes are
                supported.
              </>
            ) : (
              <>
                {conflicts.length} key{conflicts.length === 1 ? "" : "s"} already exist
                {conflicts.length === 1 ? "s" : ""} with a different value. Choose which one wins.
              </>
            )}
          </AppDialog.Description>
        </div>

        {step === "paste" ? (
          <>
            <textarea
              ref={textareaRef}
              value={pastedText}
              onChange={(e) => setPastedText(e.target.value)}
              placeholder={'FOO=bar\nexport BAZ="hello world"\n# comments supported'}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              // Focus ring is the documented shared recipe rather than a local
              // `focus:ring-*`: `docs/themes/interaction-state-recipes.md` calls
              // for `focus-visible:outline-*` for keyboard focus, and the ring
              // this replaced measured ~2.2:1 — under the 3:1 floor for a
              // non-text indicator, on the step's primary input.
              className="w-full h-56 resize-y font-mono text-xs leading-[inherit] bg-surface-input border border-border-strong rounded-[var(--radius-md)] px-3 py-2 text-text-primary placeholder:text-text-placeholder transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
              aria-label="Paste .env content"
              aria-invalid={hasErrors || undefined}
              aria-describedby={hasErrors ? errorsId : undefined}
              data-testid="import-env-textarea"
            />
            {hasErrors && (
              <div
                id={errorsId}
                role="alert"
                className="rounded-[var(--radius-md)] border border-status-warning/20 bg-status-warning/10 px-3 py-2 text-xs leading-[inherit]"
                data-testid="import-env-errors"
              >
                <div className="flex items-center gap-1.5 font-medium mb-1 text-status-warning">
                  <AlertTriangle size={12} aria-hidden="true" />
                  <span>
                    {parsed.errors.length} parse error
                    {parsed.errors.length === 1 ? "" : "s"}
                  </span>
                </div>
                {/* The tint, border and icon carry "this is a warning". The
                    lines themselves are what the user has to read and act on,
                    so they run on the audited text tiers — the amber tri-tone
                    this replaced flattened to one uniform run under
                    `forced-colors: active` anyway. */}
                <ul className="space-y-0.5 font-mono text-2xs">
                  {parsed.errors.map((e) => (
                    <li key={`${e.line}-${e.raw}`}>
                      <span className="text-text-secondary">Line {e.line}:</span>{" "}
                      <span className="font-medium text-text-primary">{e.reason}</span>
                      {/* Weight ranks the reason above the line it came from,
                          the same way the outcome rows above rank a kept value.
                          The raw line drops to its own row rather than sitting
                          inline: it is arbitrary pasted text, and reasons like
                          `Invalid key "2BAD_KEY"` already end in a quoted piece
                          of it, so inline it reads as a continuation of the
                          reason with or without a separator. */}
                      {e.raw.trim() !== "" && (
                        <div className="pl-4 break-all text-text-secondary">{e.raw}</div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {/* Shown alongside parse errors too. Gating this on a clean parse
                meant a paste that had both a bad line and a duplicated key
                reported the bad line and silently dropped the duplicate. */}
            {incomingCount > 0 && (
              <p className="text-2xs text-text-secondary" data-testid="import-env-summary">
                {incomingCount} variable{incomingCount === 1 ? "" : "s"} detected
                {conflicts.length > 0
                  ? ` · ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`
                  : ""}
                {newCount > 0 && conflicts.length > 0 ? ` · ${newCount} new` : ""}
                {conflicts.length === 0 ? " · existing values unchanged" : ""}
                {duplicateInPasteCount > 0 ? (
                  <span className="text-text-primary">
                    {" "}
                    · {duplicateInPasteCount} duplicate key
                    {duplicateInPasteCount === 1 ? "" : "s"} in paste (last value kept)
                  </span>
                ) : null}
              </p>
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
                <span className="text-2xs text-text-secondary">
                  {OUTCOME_LABEL[conflictResolution]}
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
                aria-label={`Conflicting keys — ${OUTCOME_LABEL[conflictResolution].toLowerCase()}`}
                data-testid="import-env-conflict-scroller"
              >
                <ul className="divide-y divide-tint/[0.06]">
                  {conflicts.map((c) => (
                    <li key={c.key} className="px-3 py-2">
                      <div className="font-mono text-2xs text-text-primary">{c.key}</div>
                      <dl className="mt-0.5 grid grid-cols-[max-content_1fr] items-baseline gap-x-3 gap-y-0.5">
                        <ConflictSide
                          label="Existing"
                          value={c.oldValue}
                          kept={conflictResolution === "keep"}
                        />
                        <ConflictSide
                          label="Incoming"
                          value={c.newValue}
                          kept={conflictResolution === "overwrite"}
                        />
                      </dl>
                    </li>
                  ))}
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
          disabled: !canProceed,
        }}
      />
    </AppDialog>
  );
}
