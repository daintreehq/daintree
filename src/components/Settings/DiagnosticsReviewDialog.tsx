import { useState, useEffect, useId, useMemo, useRef } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ArrowRight, ChevronRight, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  SECTION_LABELS,
  PREBUILT_REDACTIONS,
  filterSections,
  filterLogEntriesByTime,
  applyReplacements,
  type ReplacementRule,
  type PrebuiltRedactionId,
} from "@shared/utils/diagnosticsTransform";
import type { DiagnosticsReviewPayload } from "@shared/types/ipc/system";
import { safeStringify } from "@/lib/safeStringify";
import type { DiagnosticsReviewScope } from "@/store/diagnosticsReviewStore";

type TimeWindowId = "5m" | "30m" | "launch" | "full";

const TIME_WINDOW_OPTIONS: { id: TimeWindowId; label: string }[] = [
  { id: "5m", label: "Last 5 minutes" },
  { id: "30m", label: "Last 30 minutes" },
  { id: "launch", label: "Since application launch" },
  { id: "full", label: "Full log history" },
];

const DEFAULT_TIME_WINDOW: TimeWindowId = "30m";

const RULE_FIELD_CLASS =
  "h-7 min-w-0 flex-1 px-2 text-xs rounded-[var(--radius-md)] border border-border-strong bg-surface-canvas text-text-primary placeholder:text-text-placeholder focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2";

const DISCLOSURE_CLASS =
  "inline-flex items-center gap-1.5 text-sm font-medium text-text-primary rounded-[var(--radius-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2";

function isTimeWindowId(value: string): value is TimeWindowId {
  return TIME_WINDOW_OPTIONS.some((o) => o.id === value);
}

/**
 * Resolve a time-window option to an absolute ms cutoff (`null` = full history).
 * `now` is captured once when the dialog opens so the preview and the saved
 * bundle share an identical cutoff even if the user reviews for a while.
 */
function computeTimeWindowStart(
  id: TimeWindowId,
  appLaunchTimestamp: number,
  now: number
): number | null {
  switch (id) {
    case "5m":
      return now - 5 * 60 * 1000;
    case "30m":
      return now - 30 * 60 * 1000;
    case "launch":
      return appLaunchTimestamp;
    case "full":
      return null;
  }
}

interface DiagnosticsReviewDialogProps {
  isOpen: boolean;
  onClose: () => void;
  reviewPayload: DiagnosticsReviewPayload | null;
  onSave: (
    enabledSections: Record<string, boolean>,
    replacements: ReplacementRule[],
    timeWindowStartMs: number | null
  ) => void;
  isSaving: boolean;
  /**
   * Optional scope hint. When `sections` is provided, only those keys start
   * enabled; sections not listed start unchecked. The user can still toggle
   * any section manually before saving.
   */
  initialScope?: DiagnosticsReviewScope | null;
}

export function DiagnosticsReviewDialog({
  isOpen,
  onClose,
  reviewPayload,
  onSave,
  isSaving,
  initialScope,
}: DiagnosticsReviewDialogProps) {
  const [enabledSections, setEnabledSections] = useState<Record<string, boolean>>({});
  const [replacements, setReplacements] = useState<ReplacementRule[]>([
    { find: "", replace: "[REDACTED]" },
  ]);
  const [prebuiltIds, setPrebuiltIds] = useState<Set<PrebuiltRedactionId>>(new Set());
  const [timeWindow, setTimeWindow] = useState<TimeWindowId>(DEFAULT_TIME_WINDOW);
  const [showPreview, setShowPreview] = useState(false);
  const [showSections, setShowSections] = useState(false);
  const timeWindowId = useId();
  const sectionsPanelId = useId();
  const previewPanelId = useId();
  const addRuleRef = useRef<HTMLButtonElement>(null);
  // Reference "now" captured at open so the relative windows resolve to a
  // stable cutoff shared by the preview and the save call. Held as state (not a
  // ref) so the render-time reads below don't trip the React Compiler.
  const [openedAt, setOpenedAt] = useState(() => Date.now());

  useEffect(() => {
    if (isOpen && reviewPayload) {
      setOpenedAt(Date.now());
      const scopedSections = initialScope?.sections;
      const initial: Record<string, boolean> = {};
      // Distinguish "no scope" (sectionKeys undefined → all enabled) from
      // "explicit empty scope" (sectionKeys === [] → none enabled). The
      // latter would otherwise fall back to all-enabled, ignoring an
      // intentional clear from the caller.
      if (scopedSections !== undefined) {
        const allow = new Set(scopedSections);
        for (const key of reviewPayload.sectionKeys) {
          initial[key] = allow.has(key);
        }
      } else {
        for (const key of reviewPayload.sectionKeys) {
          initial[key] = true;
        }
      }
      setEnabledSections(initial);
      setReplacements([{ find: "", replace: "[REDACTED]" }]);
      setPrebuiltIds(new Set());
      setTimeWindow(DEFAULT_TIME_WINDOW);
      setShowPreview(false);
      // A caller that scoped the report opens on the sections it chose.
      setShowSections(scopedSections !== undefined);
    }
  }, [isOpen, reviewPayload, initialScope]);

  // Active prebuilt toggles contribute regex rules, prepended before the user's
  // literal rules so canonical patterns run first.
  const effectiveReplacements = useMemo<ReplacementRule[]>(() => {
    const prebuilt = PREBUILT_REDACTIONS.filter((p) => prebuiltIds.has(p.id)).flatMap(
      (p) => p.rules
    );
    return [...prebuilt, ...replacements.filter((r) => r.find)];
  }, [prebuiltIds, replacements]);

  const previewJson = useMemo(() => {
    if (!reviewPayload) return "";
    const startMs = computeTimeWindowStart(timeWindow, reviewPayload.appLaunchTimestamp, openedAt);
    const filtered = filterLogEntriesByTime(
      filterSections(reviewPayload.payload, enabledSections),
      startMs
    );
    return applyReplacements(safeStringify(filtered, 2), effectiveReplacements);
  }, [reviewPayload, enabledSections, effectiveReplacements, timeWindow, openedAt]);

  const toggleSection = (key: string) => {
    setEnabledSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const togglePrebuilt = (id: PrebuiltRedactionId) => {
    setPrebuiltIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const addReplacement = () => {
    setReplacements((prev) => [...prev, { find: "", replace: "[REDACTED]" }]);
  };

  const updateReplacement = (index: number, field: "find" | "replace", value: string) => {
    setReplacements((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  };

  const removeReplacement = (index: number) => {
    setReplacements((prev) => prev.filter((_, i) => i !== index));
    // The focused Remove button unmounts with its rule; Add rule is the stable
    // neighbour, rather than letting focus fall to the dialog body.
    addRuleRef.current?.focus();
  };

  const handleSave = () => {
    if (!reviewPayload) return;
    const startMs = computeTimeWindowStart(timeWindow, reviewPayload.appLaunchTimestamp, openedAt);
    onSave(enabledSections, effectiveReplacements, startMs);
  };

  const allEnabled = reviewPayload
    ? reviewPayload.sectionKeys.every((k) => enabledSections[k])
    : false;

  const toggleAll = () => {
    if (!reviewPayload) return;
    const newState = !allEnabled;
    const updated: Record<string, boolean> = {};
    for (const key of reviewPayload.sectionKeys) {
      updated[key] = newState;
    }
    setEnabledSections(updated);
  };

  if (!reviewPayload) return null;

  const enabledCount = reviewPayload.sectionKeys.filter((k) => enabledSections[k]).length;
  const totalSections = reviewPayload.sectionKeys.length;

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="lg" data-testid="diagnostics-review-dialog">
      <AppDialog.Header>
        <AppDialog.Title>Review diagnostics</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body className="space-y-6">
        <p className="text-sm text-text-secondary">
          Choose what goes into the report before it&apos;s saved. Saving writes a file on this
          machine; nothing is uploaded.
        </p>

        <div className="space-y-2">
          <label htmlFor={timeWindowId} className="block text-sm font-medium text-text-primary">
            Logs from
          </label>
          <select
            id={timeWindowId}
            value={timeWindow}
            onChange={(e) => {
              if (isTimeWindowId(e.target.value)) setTimeWindow(e.target.value);
            }}
            className="h-8 w-60 px-2 text-sm rounded-[var(--radius-md)] border border-border-strong bg-surface-canvas text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
          >
            {TIME_WINDOW_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-text-primary">Redact</legend>
          <div className="space-y-1.5">
            {PREBUILT_REDACTIONS.map((preset) => (
              <label
                key={preset.id}
                className="flex items-center gap-2 text-sm text-text-primary cursor-pointer"
              >
                <Checkbox
                  size="sm"
                  checked={prebuiltIds.has(preset.id)}
                  onCheckedChange={() => togglePrebuilt(preset.id)}
                />
                {preset.label}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <div className="flex items-center justify-between">
            <legend className="text-sm font-medium text-text-primary">Find and replace</legend>
            <Button ref={addRuleRef} variant="ghost" size="sm" onClick={addReplacement}>
              <Plus aria-hidden="true" />
              Add rule
            </Button>
          </div>
          <div className="space-y-2">
            {replacements.map((rule, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={rule.find}
                  onChange={(e) => updateReplacement(i, "find", e.target.value)}
                  placeholder="Text to find"
                  aria-label={`Find, rule ${i + 1}`}
                  className={RULE_FIELD_CLASS}
                />
                <ArrowRight
                  className="w-3.5 h-3.5 shrink-0 text-text-secondary"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  value={rule.replace}
                  onChange={(e) => updateReplacement(i, "replace", e.target.value)}
                  placeholder="Replace with"
                  aria-label={`Replace with, rule ${i + 1}`}
                  className={RULE_FIELD_CLASS}
                />
                {replacements.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => removeReplacement(i)}
                    aria-label={`Remove rule ${i + 1}`}
                  >
                    <X aria-hidden="true" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </fieldset>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setShowSections((v) => !v)}
              aria-expanded={showSections}
              aria-controls={sectionsPanelId}
              className={DISCLOSURE_CLASS}
            >
              <ChevronRight
                aria-hidden="true"
                data-animated-chevron
                className={cn(
                  "w-3.5 h-3.5 text-text-secondary transition-transform duration-150",
                  showSections && "rotate-90"
                )}
              />
              Sections
              <span className="font-normal text-text-secondary">
                {enabledCount} of {totalSections} included
              </span>
            </button>
            {showSections && (
              <Button variant="ghost" size="sm" onClick={toggleAll}>
                {allEnabled ? "Include none" : "Include all"}
              </Button>
            )}
          </div>
          {showSections && (
            <div id={sectionsPanelId} className="grid grid-cols-2 gap-x-4 gap-y-1.5 pl-5">
              {reviewPayload.sectionKeys.map((key) => (
                <label
                  key={key}
                  className="flex items-center gap-2 text-sm text-text-primary cursor-pointer"
                >
                  <Checkbox
                    size="sm"
                    checked={!!enabledSections[key]}
                    onCheckedChange={() => toggleSection(key)}
                  />
                  {SECTION_LABELS[key] ?? key}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            aria-expanded={showPreview}
            aria-controls={previewPanelId}
            className={DISCLOSURE_CLASS}
          >
            <ChevronRight
              aria-hidden="true"
              data-animated-chevron
              className={cn(
                "w-3.5 h-3.5 text-text-secondary transition-transform duration-150",
                showPreview && "rotate-90"
              )}
            />
            Preview the report
          </button>
          {showPreview && (
            <pre
              id={previewPanelId}
              tabIndex={0}
              aria-label="Report preview"
              className="h-[28rem] overflow-auto text-xs leading-relaxed font-mono bg-surface-canvas border border-border-default rounded-[var(--radius-md)] p-3 text-text-primary whitespace-pre-wrap break-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
            >
              {previewJson}
            </pre>
          )}
        </div>
      </AppDialog.Body>

      <AppDialog.Footer
        primaryAction={{
          label: isSaving ? "Saving…" : "Save report",
          onClick: handleSave,
          disabled: isSaving,
          loading: isSaving,
          intent: "default",
        }}
        secondaryAction={{
          label: "Cancel",
          onClick: onClose,
        }}
      />
    </AppDialog>
  );
}
