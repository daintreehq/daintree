import { useState, useEffect, useCallback, useMemo } from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { CheckIcon, Download, Eye, Replace } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  SECTION_LABELS,
  filterSections,
  applyReplacements,
  type ReplacementRule,
} from "@shared/utils/diagnosticsTransform";
import type { DiagnosticsReviewPayload } from "@shared/types/ipc/system";
import { safeStringify } from "@/lib/safeStringify";

interface DiagnosticsReviewDialogProps {
  isOpen: boolean;
  onClose: () => void;
  reviewPayload: DiagnosticsReviewPayload | null;
  onSave: (enabledSections: Record<string, boolean>, replacements: ReplacementRule[]) => void;
  isSaving: boolean;
}

export function DiagnosticsReviewDialog({
  isOpen,
  onClose,
  reviewPayload,
  onSave,
  isSaving,
}: DiagnosticsReviewDialogProps) {
  const [enabledSections, setEnabledSections] = useState<Record<string, boolean>>({});
  const [replacements, setReplacements] = useState<ReplacementRule[]>([
    { find: "", replace: "[REDACTED]" },
  ]);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    if (isOpen && reviewPayload) {
      const initial: Record<string, boolean> = {};
      for (const key of reviewPayload.sectionKeys) {
        initial[key] = true;
      }
      setEnabledSections(initial);
      setReplacements([{ find: "", replace: "[REDACTED]" }]);
      setShowPreview(false);
    }
  }, [isOpen, reviewPayload]);

  const previewJson = useMemo(() => {
    if (!reviewPayload) return "";
    const filtered = filterSections(reviewPayload.payload, enabledSections);
    let json = safeStringify(filtered, 2);
    json = applyReplacements(
      json,
      replacements.filter((r) => r.find)
    );
    return json;
  }, [reviewPayload, enabledSections, replacements]);

  const toggleSection = useCallback((key: string) => {
    setEnabledSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const addReplacement = useCallback(() => {
    setReplacements((prev) => [...prev, { find: "", replace: "[REDACTED]" }]);
  }, []);

  const updateReplacement = useCallback(
    (index: number, field: "find" | "replace", value: string) => {
      setReplacements((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
    },
    []
  );

  const removeReplacement = useCallback((index: number) => {
    setReplacements((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSave = useCallback(() => {
    onSave(
      enabledSections,
      replacements.filter((r) => r.find)
    );
  }, [enabledSections, replacements, onSave]);

  const allEnabled = reviewPayload
    ? reviewPayload.sectionKeys.every((k) => enabledSections[k])
    : false;

  const toggleAll = useCallback(() => {
    if (!reviewPayload) return;
    const newState = !allEnabled;
    const updated: Record<string, boolean> = {};
    for (const key of reviewPayload.sectionKeys) {
      updated[key] = newState;
    }
    setEnabledSections(updated);
  }, [reviewPayload, allEnabled]);

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
            <h4 className="text-sm font-medium text-daintree-text">Sections</h4>
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
                    ? "border-daintree-border bg-daintree-bg/50 text-daintree-text"
                    : "border-daintree-border/40 bg-transparent text-daintree-text/40 line-through"
                )}
              >
                <CheckboxPrimitive.Root
                  checked={enabledSections[key]}
                  onCheckedChange={() => toggleSection(key)}
                  className={cn(
                    "flex shrink-0 w-3.5 h-3.5 rounded border transition-colors",
                    "bg-daintree-bg border-border-strong",
                    "data-[state=checked]:bg-daintree-accent data-[state=checked]:border-daintree-accent",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
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
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium text-daintree-text flex items-center gap-1.5">
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
                    "h-7 text-xs flex-1 px-2 rounded border border-daintree-border bg-daintree-bg",
                    "text-daintree-text placeholder:text-daintree-text/30",
                    "focus:outline-hidden focus:border-daintree-accent"
                  )}
                />
                <span className="text-daintree-text/40 text-xs">→</span>
                <input
                  type="text"
                  value={rule.replace}
                  onChange={(e) => updateReplacement(i, "replace", e.target.value)}
                  placeholder="Replace with"
                  className={cn(
                    "h-7 text-xs flex-1 px-2 rounded border border-daintree-border bg-daintree-bg",
                    "text-daintree-text placeholder:text-daintree-text/30",
                    "focus:outline-hidden focus:border-daintree-accent"
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
            <pre className="text-[10px] leading-relaxed font-mono bg-daintree-bg border border-daintree-border rounded p-3 max-h-64 overflow-auto text-daintree-text/80 whitespace-pre-wrap break-all">
              {previewJson}
            </pre>
          )}
        </div>
      </AppDialog.Body>

      <AppDialog.Footer
        primaryAction={{
          label: isSaving ? "Saving..." : "Save Bundle",
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
