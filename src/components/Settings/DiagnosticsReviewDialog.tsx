import { useState, useEffect, useMemo } from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { CheckIcon, Clock, Download, Eye, Replace, ShieldOff } from "lucide-react";
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

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="lg" data-testid="diagnostics-review-dialog">
      <AppDialog.Header>
        <AppDialog.Title icon={<Download className="w-5 h-5" />}>
          Review Diagnostics
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body className="space-y-4">
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium text-text-primary">Sections</h4>
            <Button variant="ghost" size="sm" onClick={toggleAll} className="text-xs h-6 px-2">
              {allEnabled ? "Deselect All" : "Select All"}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {reviewPayload.sectionKeys.map((key) => (
              <label
                key={key}
                className={cn(
                  "flex items-center gap-2 px-2.5 py-1.5 rounded border text-xs cursor-pointer transition-colors",
                  enabledSections[key]
                    ? "border-border-default bg-daintree-bg/50 text-text-primary"
                    : "border-daintree-border/40 bg-transparent text-daintree-text/40 line-through"
                )}
              >
                <CheckboxPrimitive.Root
                  checked={enabledSections[key]}
                  onCheckedChange={() => toggleSection(key)}
                  className={cn(
                    "flex shrink-0 w-3.5 h-3.5 rounded-sm border transition-colors",
                    "bg-surface-canvas border-border-strong",
                    "data-[state=checked]:bg-text-primary data-[state=checked]:border-text-primary",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                  )}
                >
                  <CheckboxPrimitive.Indicator className="flex items-center justify-center text-text-inverse">
                    <CheckIcon className="w-2.5 h-2.5" />
                  </CheckboxPrimitive.Indicator>
                </CheckboxPrimitive.Root>
                {SECTION_LABELS[key] ?? key}
              </label>
            ))}
          </div>
        </div>

        <div>
          <h4 className="text-sm font-medium text-text-primary flex items-center gap-1.5 mb-2">
            <Clock className="w-3.5 h-3.5" />
            Log time window
          </h4>
          <select
            value={timeWindow}
            onChange={(e) => {
              if (isTimeWindowId(e.target.value)) setTimeWindow(e.target.value);
            }}
            aria-label="Log time window"
            className={cn(
              "h-8 text-xs w-full px-2 rounded-[var(--radius-md)] border border-border-default bg-surface-canvas",
              "text-text-primary focus:outline-hidden focus:border-daintree-accent/40"
            )}
          >
            {TIME_WINDOW_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <h4 className="text-sm font-medium text-text-primary flex items-center gap-1.5 mb-2">
            <ShieldOff className="w-3.5 h-3.5" />
            Prebuilt redactions
          </h4>
          <div className="grid grid-cols-1 gap-1.5">
            {PREBUILT_REDACTIONS.map((preset) => (
              <label
                key={preset.id}
                className={cn(
                  "flex items-center gap-2 px-2.5 py-1.5 rounded border text-xs cursor-pointer transition-colors",
                  prebuiltIds.has(preset.id)
                    ? "border-border-default bg-daintree-bg/50 text-text-primary"
                    : "border-daintree-border/40 bg-transparent text-text-secondary"
                )}
              >
                <CheckboxPrimitive.Root
                  checked={prebuiltIds.has(preset.id)}
                  onCheckedChange={() => togglePrebuilt(preset.id)}
                  className={cn(
                    "flex shrink-0 w-3.5 h-3.5 rounded-sm border transition-colors",
                    "bg-surface-canvas border-border-strong",
                    "data-[state=checked]:bg-text-primary data-[state=checked]:border-text-primary",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                  )}
                >
                  <CheckboxPrimitive.Indicator className="flex items-center justify-center text-text-inverse">
                    <CheckIcon className="w-2.5 h-2.5" />
                  </CheckboxPrimitive.Indicator>
                </CheckboxPrimitive.Root>
                {preset.label}
              </label>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium text-text-primary flex items-center gap-1.5">
              <Replace className="w-3.5 h-3.5" />
              Find &amp; Replace
            </h4>
            <Button variant="ghost" size="sm" onClick={addReplacement} className="text-xs h-6 px-2">
              Add Rule
            </Button>
          </div>
          <div className="space-y-2">
            {replacements.map((rule, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={rule.find}
                  onChange={(e) => updateReplacement(i, "find", e.target.value)}
                  placeholder="Find text"
                  className={cn(
                    "h-7 text-xs flex-1 px-2 rounded-[var(--radius-md)] border border-border-default bg-surface-canvas",
                    "text-text-primary placeholder:text-text-placeholder",
                    "focus:outline-hidden focus:border-daintree-accent/40"
                  )}
                />
                <span className="text-daintree-text/40 text-xs">→</span>
                <input
                  type="text"
                  value={rule.replace}
                  onChange={(e) => updateReplacement(i, "replace", e.target.value)}
                  placeholder="Replace with"
                  className={cn(
                    "h-7 text-xs flex-1 px-2 rounded-[var(--radius-md)] border border-border-default bg-surface-canvas",
                    "text-text-primary placeholder:text-text-placeholder",
                    "focus:outline-hidden focus:border-daintree-accent/40"
                  )}
                />
                {replacements.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeReplacement(i)}
                    className="text-xs h-7 px-1.5 text-daintree-text/40 hover:text-status-error"
                  >
                    ×
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowPreview(!showPreview)}
            className="text-xs flex items-center gap-1.5 mb-2"
          >
            <Eye className="w-3.5 h-3.5" />
            {showPreview ? "Hide Preview" : "Show Preview"}
          </Button>
          {showPreview && (
            <pre className="text-3xs leading-relaxed font-mono bg-surface-canvas border border-border-default rounded p-3 max-h-64 overflow-auto text-text-primary whitespace-pre-wrap break-all">
              {previewJson}
            </pre>
          )}
        </div>
      </AppDialog.Body>

      <AppDialog.Footer
        primaryAction={{
          label: isSaving ? "Saving…" : "Save Bundle",
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
