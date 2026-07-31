import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { CircleCheck, MessageCircleQuestion, OctagonAlert, Radar } from "@/components/icons";
import { cn } from "@/lib/utils";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { useOverlayClaim, useDohertyGate } from "@/hooks";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { usePilotStore } from "@/store/pilotStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { getAgentConfig } from "@shared/config/agentRegistry";
import { BAND_TONE, countDemands, type FleetBand } from "@/lib/fleetAttention";
import type { ProjectRowTone } from "@/lib/projectRowStatus";
import { BAND_LABEL, buildPilotSections, type PilotRow } from "./pilotRows";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";

/** Shared with the project switcher so one vocabulary of status colour serves both. */
const TONE_TEXT: Record<ProjectRowTone, string> = {
  blocked: "text-status-danger/80",
  waiting: "text-activity-waiting",
  review: "text-activity-completed",
  working: "text-activity-working",
  running: "text-daintree-text/50",
  muted: "text-daintree-text/50",
};

/**
 * Band glyphs. Always rendered beside the band's word, never alone — status
 * must not be carried by colour or shape on its own.
 */
const BAND_ICON: Record<FleetBand, typeof OctagonAlert> = {
  blocked: OctagonAlert,
  "needs-you": MessageCircleQuestion,
  review: CircleCheck,
  running: Radar,
  idle: Radar,
};

/** Ages are minute-grained, so a 30s tick keeps them honest without churn. */
const AGE_TICK_MS = 30_000;

/**
 * One run.
 *
 * Carries no selected state yet: there is no keyboard model here, so a
 * selection style would be dead — and the accent it would spend is the single
 * load-bearing signal this region gets. It belongs to the focus anchor when
 * arrow-key navigation lands, not to a branch that can't currently be true.
 */
function PilotRowItem({ row }: { row: PilotRow }) {
  const Icon = BAND_ICON[row.band];
  const tone = TONE_TEXT[BAND_TONE[row.band]];

  return (
    <div
      data-testid="pilot-row"
      className="flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-sm"
    >
      <Icon className={cn("size-4 shrink-0", tone)} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-daintree-text/90">{row.workspaceName}</span>
        {row.branchLabel && (
          <span className="text-daintree-text/50">{` · ${row.branchLabel}`}</span>
        )}
      </span>
      {row.agentLabel && (
        <span className="shrink-0 text-xs text-daintree-text/50">{row.agentLabel}</span>
      )}
      <span className={cn("w-14 shrink-0 text-right text-xs tabular-nums", tone)}>
        {row.age ?? "—"}
      </span>
    </div>
  );
}

export function PilotView() {
  const close = usePilotStore((s) => s.close);
  const snapshot = useFleetSnapshotStore((s) => s.snapshot);
  const projects = useProjectStore((s) => s.projects);
  const scratches = useScratchStore((s) => s.scratches);

  // Claim the viewport so AppLayout marks the app chrome inert. Without it the
  // covered terminal keeps focus and ordinary typing still reaches the agent
  // behind this view — and the global key dispatcher only routes Escape from a
  // non-editable focus, so Pilot could not even be closed with the keyboard.
  useOverlayClaim("pilot", true);
  useEscapeStack(true, close);

  // Take focus on open and hand it back on close, which is what makes the
  // `aria-modal` claim above true rather than decorative.
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    containerRef.current?.focus();
    return () => {
      // Narrowed rather than asserted: `activeElement` is `Element | null`, and
      // only an HTMLElement is focusable.
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);

  // The clock is state, not a bare tick counter, and it is a real dependency of
  // the row build below. A `setTick(n => n + 1)` that nothing reads is a no-op
  // under the React Compiler — it memoizes the derived rows on their declared
  // inputs, so a counter absent from those inputs never recomputes an age. That
  // exact pattern is already dead in the project switcher; threading the
  // timestamp through makes the dependency explicit instead of incidental.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Names come from these two lists, and neither is guaranteed to be populated
  // when Pilot opens: the boot load of scratches is fire-and-forget and its
  // documented self-heal is "the switcher reloads them whenever it opens"
  // (#11518). Pilot is reachable by keybinding without ever opening the
  // switcher, so it refreshes them itself — the same `allSettled` pair the
  // palette runs on open. Both loaders dedupe in flight, so this is cheap.
  useEffect(() => {
    // `allSettled` never rejects, so it cannot be handed straight to
    // safeFireAndForget — the error context would be unreachable and a failed
    // scratch load would silently leave live runs labelled "Unknown workspace".
    // Inspect the settled results and rethrow so the failure is actually
    // reported.
    safeFireAndForget(
      Promise.allSettled([
        useProjectStore.getState().loadProjects(),
        useScratchStore.getState().loadScratches(),
      ]).then((results) => {
        const failed = results.filter((r) => r.status === "rejected");
        if (failed.length > 0) {
          throw new AggregateError(
            failed.map((r) => r.reason),
            "Workspace name hydrate failed"
          );
        }
      }),
      { context: "PilotView workspace name hydrate" }
    );
  }, []);

  const workspaceNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) map.set(project.id, project.name);
    for (const scratch of scratches) map.set(scratch.id, scratch.name);
    return map;
  }, [projects, scratches]);

  const sections = useMemo(() => {
    if (!snapshot) return [];
    const agentNames = new Map<string, string>();
    for (const run of snapshot.runs) {
      if (run.agentId && !agentNames.has(run.agentId)) {
        agentNames.set(run.agentId, getAgentConfig(run.agentId)?.name ?? run.agentId);
      }
    }
    return buildPilotSections(snapshot.runs, { workspaceNames, agentNames, nowMs });
  }, [snapshot, workspaceNames, nowMs]);

  const demandCount = snapshot ? countDemands(snapshot.runs) : 0;
  const runCount = snapshot?.runs.length ?? 0;
  // The store hydrates on mount, so this normally resolves well inside the
  // Doherty threshold. Announcing a load before then would advertise a wait the
  // user was never going to notice.
  const showLoadingCopy = useDohertyGate(snapshot === null);

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      // `z-[var(--z-modal)]`, not `z-modal`: the latter is only a CSS custom
      // property, so Tailwind emits no such utility and the overlay would land
      // with no stacking context at all — under the toolbar.
      className="fixed inset-0 z-[var(--z-modal)] flex flex-col bg-daintree-bg"
      role="dialog"
      aria-modal="true"
      aria-label="Fleet overview"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-daintree-border px-4 py-3">
        <Radar className="size-4 text-daintree-text/70" aria-hidden="true" />
        <h1 className="text-sm font-medium text-daintree-text">Pilot</h1>
        <p className="min-w-0 flex-1 truncate text-xs text-daintree-text/50">
          {snapshot === null
            ? showLoadingCopy
              ? "Loading the fleet"
              : ""
            : demandCount > 0
              ? `${demandCount} ${demandCount === 1 ? "run needs" : "runs need"} you`
              : runCount > 0
                ? `Nothing needs you · ${runCount} ${runCount === 1 ? "run" : "runs"} in flight`
                : "Nothing running"}
        </p>
        <button
          type="button"
          onClick={close}
          aria-label="Close fleet overview"
          className="rounded-[var(--radius-md)] p-1 text-daintree-text/60 transition-colors duration-150 ease-out hover:text-daintree-text"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {snapshot === null ? (
          // Predictable shape, so a skeleton rather than a spinner. The store
          // hydrates on mount, so this is a first-paint state, not a stall.
          <>
            <Skeleton className="flex flex-col gap-2" data-testid="pilot-skeleton">
              {Array.from({ length: 4 }, (_, i) => (
                <SkeletonBone key={i} className="h-9 w-full" />
              ))}
            </Skeleton>
            {/* A snapshot that never arrives would otherwise pulse forever. */}
            <SkeletonHint />
          </>
        ) : runCount === 0 ? (
          <EmptyState
            variant="zero-data"
            scale="canvas"
            icon={<Radar className="size-6" />}
            title="Launch an agent"
            description="Agents you start in any project show up here"
          />
        ) : (
          <div className="flex flex-col gap-4">
            {sections.map((section) => (
              <section key={section.band} aria-label={BAND_LABEL[section.band]}>
                <h2 className="px-3 pb-1 text-[11px] font-medium tracking-wide text-daintree-text/50 uppercase">
                  {BAND_LABEL[section.band]}
                  <span className="ml-2 tabular-nums">{section.rows.length}</span>
                </h2>
                <div className="flex flex-col">
                  {section.rows.map((row) => (
                    <PilotRowItem key={row.run.runId} row={row} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
