import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
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

export function ImportEnvDialog({ isOpen, onClose, env, onImport }: ImportEnvDialogProps) {
  const [pastedText, setPastedText] = useState("");
  const [step, setStep] = useState<Step>("paste");
  const [conflictResolution, setConflictResolution] = useState<ConflictResolution>("keep");

  // Single reset effect keyed on [isOpen] — avoids the split-effect trap from #4958.
  useEffect(() => {
    if (isOpen) {
      setPastedText("");
      setStep("paste");
      setConflictResolution("keep");
    }
  }, [isOpen]);

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

  const primaryLabel =
    step === "conflicts"
      ? conflictResolution === "keep"
        ? "Import, keep existing"
        : "Import, overwrite conflicts"
      : conflicts.length > 0
        ? `Review ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`
        : incomingCount > 0
          ? `Import ${incomingCount} variable${incomingCount === 1 ? "" : "s"}`
          : "Import";

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
      data-testid="import-env-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title>Import .env</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body className="space-y-3">
        {step === "paste" ? (
          <>
            <AppDialog.Description>
              Paste the contents of a .env file. Keys must match{" "}
              <code className="text-[11px]">[A-Za-z_][A-Za-z0-9_]*</code>. Quoted values, comments,
              and <code className="text-[11px]">export</code> prefixes are supported.
            </AppDialog.Description>
            <textarea
              value={pastedText}
              onChange={(e) => setPastedText(e.target.value)}
              placeholder={'FOO=bar\nexport BAZ="hello world"\n# comments supported'}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="w-full h-56 resize-y font-mono text-[12px] bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-3 py-2 outline-hidden focus:ring-2 focus:ring-daintree-accent/40 text-daintree-text"
              aria-label="Paste .env content"
              data-testid="import-env-textarea"
            />
            {hasErrors && (
              <div
                className="rounded-[var(--radius-md)] border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-[12px] text-status-warning"
                data-testid="import-env-errors"
              >
                <div className="flex items-center gap-1.5 font-medium mb-1">
                  <AlertTriangle size={12} aria-hidden="true" />
                  <span>
                    {parsed.errors.length} parse error
                    {parsed.errors.length === 1 ? "" : "s"}
                  </span>
                </div>
                <ul className="space-y-0.5 font-mono text-[11px]">
                  {parsed.errors.map((e) => (
                    <li key={`${e.line}-${e.raw}`}>
                      <span className="text-status-warning/70">Line {e.line}:</span> {e.reason}
                      {e.raw.trim() !== "" && (
                        <span className="text-daintree-text/50"> — {e.raw}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!hasErrors && incomingCount > 0 && (
              <p className="text-[11px] text-daintree-text/50" data-testid="import-env-summary">
                {incomingCount} variable{incomingCount === 1 ? "" : "s"} detected
                {conflicts.length > 0
                  ? ` · ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`
                  : ""}
                {newCount > 0 && conflicts.length > 0 ? ` · ${newCount} new` : ""}
                {duplicateInPasteCount > 0
                  ? ` · ${duplicateInPasteCount} duplicate key${duplicateInPasteCount === 1 ? "" : "s"} in paste (last value kept)`
                  : ""}
              </p>
            )}
          </>
        ) : (
          <>
            <AppDialog.Description>
              {conflicts.length} key{conflicts.length === 1 ? "" : "s"} already exist
              {conflicts.length === 1 ? "s" : ""}. Choose how to merge.
            </AppDialog.Description>
            <fieldset className="space-y-2">
              <legend className="sr-only">Conflict resolution</legend>
              <ConflictOption
                checked={conflictResolution === "keep"}
                onChange={() => setConflictResolution("keep")}
                label="Keep existing"
                description="Only add new keys — leave colliding values untouched."
                testId="import-env-mode-keep"
              />
              <ConflictOption
                checked={conflictResolution === "overwrite"}
                onChange={() => setConflictResolution("overwrite")}
                label="Overwrite conflicts"
                description="Replace colliding values with the pasted ones."
                testId="import-env-mode-overwrite"
              />
            </fieldset>
            <div
              className="rounded-[var(--radius-md)] border border-daintree-border overflow-hidden"
              data-testid="import-env-conflict-list"
            >
              <div className="bg-daintree-bg/40 px-3 py-1.5 text-[10px] uppercase tracking-wide text-daintree-text/50 border-b border-daintree-border">
                Conflicts ({conflicts.length})
              </div>
              <ul className="max-h-48 overflow-y-auto divide-y divide-daintree-border/60">
                {conflicts.map((c) => (
                  <li key={c.key} className="px-3 py-1.5 font-mono text-[11px]">
                    <div className="text-daintree-text/80">{c.key}</div>
                    <div className="text-daintree-text/50">
                      <span className="line-through">{c.oldValue || "(empty)"}</span>
                      <span className="mx-1.5">→</span>
                      <span className="text-daintree-accent">{c.newValue || "(empty)"}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </AppDialog.Body>

      <AppDialog.Footer
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

function ConflictOption({
  checked,
  onChange,
  label,
  description,
  testId,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  description: string;
  testId: string;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer group">
      <input
        type="radio"
        name="import-env-conflict-mode"
        checked={checked}
        onChange={onChange}
        className="mt-0.5 shrink-0 accent-daintree-accent"
        data-testid={testId}
      />
      <div>
        <span className="text-sm font-medium text-daintree-text group-hover:text-daintree-text transition-colors">
          {label}
        </span>
        <p className="text-xs text-daintree-text/40">{description}</p>
      </div>
    </label>
  );
}
