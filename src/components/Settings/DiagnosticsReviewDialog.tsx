import { useState, useEffect, useId, useMemo, useRef, type ReactNode } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { ArrowDown, ArrowRight, ChevronRight, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  SECTION_LABELS,
  PREBUILT_REDACTIONS,
  filterSections,
  filterLogEntriesByTime,
  applyReplacementsCounted,
  type ReplacementRule,
  type PrebuiltRedactionId,
} from "@shared/utils/diagnosticsTransform";
import type { DiagnosticsReviewPayload } from "@shared/types/ipc/system";
import { safeStringify } from "@/lib/safeStringify";
import type { DiagnosticsReviewScope } from "@/store/diagnosticsReviewStore";

type TimeWindowId = "5m" | "30m" | "launch" | "update" | "full";

const LAUNCH_OPTIONS: { id: TimeWindowId; label: string }[] = [
  { id: "5m", label: "Last 5 minutes" },
  { id: "30m", label: "Last 30 minutes" },
  { id: "launch", label: "Since application launch" },
];

const FULL_OPTION: { id: TimeWindowId; label: string } = { id: "full", label: "Full log history" };

/**
 * The update option only appears once a version change has been observed —
 * without one there's no honest boundary to offer.
 */
function getTimeWindowOptions(
  payload: DiagnosticsReviewPayload
): { id: TimeWindowId; label: string }[] {
  const boundary = payload.versionFirstRun;
  if (!boundary) return [...LAUNCH_OPTIONS, FULL_OPTION];
  return [
    ...LAUNCH_OPTIONS,
    { id: "update", label: `Since updating to ${boundary.version}` },
    FULL_OPTION,
  ];
}

/** True when rotation already dropped logs written after the version boundary. */
function updateBoundaryPredatesRetainedLogs(payload: DiagnosticsReviewPayload): boolean {
  const boundary = payload.versionFirstRun;
  return (
    boundary !== null &&
    payload.oldestRetainedLogMs !== null &&
    boundary.firstRunAtMs < payload.oldestRetainedLogMs
  );
}

const DEFAULT_TIME_WINDOW: TimeWindowId = "30m";

const DISCLOSURE_CLASS =
  "inline-flex items-center gap-1.5 text-sm font-medium text-text-primary rounded-[var(--radius-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2";

const GROUP_HEADING_CLASS = "text-sm font-medium text-text-primary";

function formatMatches(count: number): string {
  if (count === 0) return "No matches";
  return count === 1 ? "1 match" : `${count} matches`;
}

/**
 * The report text with every replacement drawn as a neutral band. `active` is
 * the one "Next replacement" last moved to, outlined so it can be told apart
 * from its neighbours in the same view.
 */
function MarkedReport({
  text,
  ranges,
  active,
}: {
  text: string;
  ranges: [number, number][];
  active: number | null;
}) {
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], i) => {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <span
        key={start}
        data-replacement
        className={cn(
          "rounded-[var(--radius-xs)] bg-overlay-strong text-text-primary",
          i === active && "outline outline-1 outline-text-secondary"
        )}
      >
        {text.slice(start, end + 1)}
      </span>
    );
    at = end + 1;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

function isTimeWindowId(value: string, options: { id: TimeWindowId }[]): value is TimeWindowId {
  return options.some((o) => o.id === value);
}

/**
 * Resolve a time-window option to an absolute ms cutoff (`null` = full history).
 * `now` is captured once when the dialog opens so the preview and the saved
 * bundle share an identical cutoff even if the user reviews for a while.
 */
function computeTimeWindowStart(
  id: TimeWindowId,
  payload: DiagnosticsReviewPayload,
  now: number
): number | null {
  switch (id) {
    case "5m":
      return now - 5 * 60 * 1000;
    case "30m":
      return now - 30 * 60 * 1000;
    case "launch":
      return payload.appLaunchTimestamp;
    case "update":
      // Once rotation has cut into the version's logs, everything retained is
      // the best available answer — the same report as full history.
      if (!payload.versionFirstRun || updateBoundaryPredatesRetainedLogs(payload)) return null;
      return payload.versionFirstRun.firstRunAtMs;
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
  const [showSections, setShowSections] = useState(false);
  const timeWindowId = useId();
  const timeWindowHintId = useId();
  const rulesHeadingId = useId();
  const ruleIdPrefix = useId();
  const sectionsToggleId = useId();
  const sectionsPanelId = useId();
  const previewHeadingId = useId();
  const previewMetaId = useId();
  const previewRegionRef = useRef<HTMLDivElement>(null);
  const addRuleRef = useRef<HTMLButtonElement>(null);
  // Set by Add rule so the new row's Find field takes focus once it mounts,
  // instead of leaving the keyboard user on Add rule, above every older rule.
  const focusNewRuleRef = useRef(false);
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
      // A caller that scoped the report opens on the sections it chose.
      setShowSections(scopedSections !== undefined);
    }
  }, [isOpen, reviewPayload, initialScope]);

  useEffect(() => {
    if (!focusNewRuleRef.current) return;
    focusNewRuleRef.current = false;
    document.getElementById(`${ruleIdPrefix}-find-${replacements.length - 1}`)?.focus();
  }, [replacements.length, ruleIdPrefix]);

  // Active prebuilt toggles contribute regex rules, prepended before the user's
  // literal rules so canonical patterns run first. Each rule remembers whose it
  // is, so the counts can be reported against the control that added it.
  const ownedRules = useMemo(() => {
    const prebuilt = PREBUILT_REDACTIONS.filter((p) => prebuiltIds.has(p.id)).flatMap((p) =>
      p.rules.map((rule) => ({ rule, owner: p.id as PrebuiltRedactionId | number }))
    );
    const custom = replacements.flatMap((rule, index) =>
      rule.find ? [{ rule, owner: index as PrebuiltRedactionId | number }] : []
    );
    return [...prebuilt, ...custom];
  }, [prebuiltIds, replacements]);

  const effectiveReplacements = useMemo<ReplacementRule[]>(
    () => ownedRules.map((o) => o.rule),
    [ownedRules]
  );

  const preview = useMemo(() => {
    if (!reviewPayload) {
      return {
        text: "",
        ranges: [] as [number, number][],
        matchCounts: new Map<PrebuiltRedactionId | number, number>(),
      };
    }
    const startMs = computeTimeWindowStart(timeWindow, reviewPayload, openedAt);
    const filtered = filterLogEntriesByTime(
      filterSections(reviewPayload.payload, enabledSections),
      startMs
    );
    const { output, counts, ranges } = applyReplacementsCounted(
      safeStringify(filtered, 2),
      effectiveReplacements
    );
    const matchCounts = new Map<PrebuiltRedactionId | number, number>();
    ownedRules.forEach(({ owner }, i) => {
      matchCounts.set(owner, (matchCounts.get(owner) ?? 0) + (counts[i] ?? 0));
    });
    return { text: output, ranges, matchCounts };
  }, [reviewPayload, enabledSections, effectiveReplacements, ownedRules, timeWindow, openedAt]);

  // Which replacement "Next replacement" last moved to, tied to the ranges it
  // walked so any edit to the report starts the walk again — even one that
  // leaves the text identical but moves or renumbers the marks.
  const [cursor, setCursor] = useState<{ ranges: [number, number][]; index: number } | null>(null);
  const activeReplacement = cursor?.ranges === preview.ranges ? cursor.index : null;

  const showNextReplacement = () => {
    const region = previewRegionRef.current;
    if (!region || preview.ranges.length === 0) return;
    const index = activeReplacement === null ? 0 : (activeReplacement + 1) % preview.ranges.length;
    setCursor({ ranges: preview.ranges, index });
    const mark = region.querySelectorAll<HTMLElement>("[data-replacement]")[index];
    if (!mark) return;
    const offset = mark.getBoundingClientRect().top - region.getBoundingClientRect().top;
    region.scrollTop += offset - region.clientHeight / 3;
    // The preview may itself sit partly below the body's fold.
    mark.scrollIntoView({ block: "nearest" });
  };

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
    focusNewRuleRef.current = true;
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
    const startMs = computeTimeWindowStart(timeWindow, reviewPayload, openedAt);
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
  const timeWindowOptions = getTimeWindowOptions(reviewPayload);
  const showRotationHint =
    timeWindow === "update" && updateBoundaryPredatesRetainedLogs(reviewPayload);
  const replacementCount = preview.ranges.length;
  const previewLines = preview.text.split("\n").length;

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="lg" data-testid="diagnostics-review-dialog">
      <AppDialog.Header>
        <AppDialog.Title>Review diagnostics</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body className="space-y-6">
        <AppDialog.Description>
          Choose what goes into the report before it&apos;s saved. Saving writes a file on this
          machine; nothing is uploaded.
        </AppDialog.Description>

        {/* Frozen while saving: the preview below is what was consented to, so
            nothing may change it after Save has handed the settings over. */}
        <fieldset disabled={isSaving} className="min-w-0 space-y-6">
          <div className="space-y-2">
            <label htmlFor={timeWindowId} className={cn("block", GROUP_HEADING_CLASS)}>
              Logs from
            </label>
            <Select
              value={timeWindow}
              onValueChange={(value) => {
                if (isTimeWindowId(value, timeWindowOptions)) setTimeWindow(value);
              }}
              disabled={isSaving}
            >
              <SelectTrigger
                id={timeWindowId}
                aria-describedby={showRotationHint ? timeWindowHintId : undefined}
                className="w-72"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {timeWindowOptions.map((opt) => (
                  <SelectItem key={opt.id} value={opt.id}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {showRotationHint && (
              <p id={timeWindowHintId} className="text-xs text-text-secondary">
                Older logs from this version have rotated out, so this includes every log still
                kept.
              </p>
            )}
          </div>

          <fieldset className="min-w-0 space-y-2">
            <legend className={GROUP_HEADING_CLASS}>Redact</legend>
            <p className="text-xs text-text-secondary">
              These match patterns, so they can miss things. Check the preview before you share the
              report.
            </p>
            <div className="space-y-1.5">
              {PREBUILT_REDACTIONS.map((preset) => {
                const active = prebuiltIds.has(preset.id);
                // The count sits beside the label, not in it, so the checkbox's
                // name stays the same as its count appears and changes.
                const countId = `${ruleIdPrefix}-preset-${preset.id}`;
                return (
                  <div key={preset.id} className="flex items-center gap-2">
                    <label className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
                      <Checkbox
                        size="sm"
                        checked={active}
                        onCheckedChange={() => togglePrebuilt(preset.id)}
                        aria-describedby={active ? countId : undefined}
                      />
                      {preset.label}
                    </label>
                    {active && (
                      <span id={countId} className="text-xs text-text-secondary tabular-nums">
                        {formatMatches(preview.matchCounts.get(preset.id) ?? 0)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </fieldset>

          <div role="group" aria-labelledby={rulesHeadingId} className="space-y-2">
            <div className="flex items-center justify-between">
              <span id={rulesHeadingId} className={GROUP_HEADING_CLASS}>
                Find and replace
              </span>
              <Button ref={addRuleRef} variant="ghost" size="sm" onClick={addReplacement}>
                <Plus aria-hidden="true" />
                Add rule
              </Button>
            </div>
            <div className="space-y-2">
              {replacements.map((rule, i) => {
                const countId = `${ruleIdPrefix}-count-${i}`;
                return (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      id={`${ruleIdPrefix}-find-${i}`}
                      density="compact"
                      value={rule.find}
                      onChange={(e) => updateReplacement(i, "find", e.target.value)}
                      placeholder="Text to find"
                      aria-label={`Find, rule ${i + 1}`}
                      aria-describedby={rule.find ? countId : undefined}
                      className="min-w-0 flex-1"
                    />
                    <ArrowRight
                      className="w-3.5 h-3.5 shrink-0 text-text-secondary"
                      aria-hidden="true"
                    />
                    <Input
                      density="compact"
                      value={rule.replace}
                      onChange={(e) => updateReplacement(i, "replace", e.target.value)}
                      placeholder="Replace with"
                      aria-label={`Replace with, rule ${i + 1}`}
                      className="min-w-0 flex-1"
                    />
                    <span
                      id={countId}
                      className="w-20 shrink-0 text-right text-xs text-text-secondary tabular-nums"
                    >
                      {rule.find ? formatMatches(preview.matchCounts.get(i) ?? 0) : null}
                    </span>
                    {/* The slot is held for a single rule too, so the fields keep
                        their width when a second rule adds its Remove button. */}
                    <div className="w-7 shrink-0">
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
                  </div>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                id={sectionsToggleId}
                onClick={() => setShowSections((v) => !v)}
                aria-expanded={showSections}
                aria-controls={sectionsPanelId}
                className={DISCLOSURE_CLASS}
              >
                <ChevronRight
                  aria-hidden="true"
                  data-animated-chevron
                  className={cn(
                    "w-3.5 h-3.5 text-text-secondary transition-transform duration-150 ease-out",
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
            <div
              id={sectionsPanelId}
              hidden={!showSections}
              role="group"
              aria-labelledby={sectionsToggleId}
              className="grid grid-cols-2 gap-x-4 gap-y-1.5 pl-5"
            >
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
          </div>
        </fieldset>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h3 id={previewHeadingId} className={GROUP_HEADING_CLASS}>
              Report preview
            </h3>
            <div className="flex items-center gap-3">
              <p
                id={previewMetaId}
                aria-live="polite"
                className="text-xs text-text-secondary tabular-nums"
              >
                {previewLines.toLocaleString()} lines
                {replacementCount > 0 &&
                  (activeReplacement === null
                    ? ` · ${replacementCount.toLocaleString()} replaced`
                    : ` · replacement ${activeReplacement + 1} of ${replacementCount}`)}
              </p>
              {replacementCount > 0 && (
                <Button variant="ghost" size="sm" onClick={showNextReplacement}>
                  <ArrowDown aria-hidden="true" />
                  Next replacement
                </Button>
              )}
            </div>
          </div>
          <ScrollShadow
            compact
            className="rounded-[var(--radius-md)] border border-border-default bg-surface-canvas"
            scrollClassName="max-h-[min(28rem,40vh)] min-h-24 overscroll-contain p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
            ref={previewRegionRef}
            tabIndex={0}
            role="region"
            aria-labelledby={previewHeadingId}
            aria-describedby={previewMetaId}
          >
            <pre className="text-xs leading-relaxed font-mono text-text-primary whitespace-pre-wrap break-all">
              <MarkedReport
                text={preview.text}
                ranges={preview.ranges}
                active={activeReplacement}
              />
            </pre>
          </ScrollShadow>
        </div>
      </AppDialog.Body>

      <AppDialog.Footer
        primaryAction={{
          label: "Save report",
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
