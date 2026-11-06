import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { HostFleetTarget } from "@shared/types/ipc/hostMetrics";
import type { HostId } from "@shared/types/remoteHosts";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton, SkeletonBone, SkeletonHint } from "@/components/ui/Skeleton";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { STATE_COLORS, STATE_ICONS, STATE_LABELS } from "@/components/Worktree/terminalStateConfig";
import {
  armCrossHostTarget,
  crossHostTargetKey,
  disarmCrossHostTarget,
  shortTerminalId,
  useArmedCrossHostTargets,
} from "@/components/Fleet/crossHostFleet";
import { RemoteAgentMark } from "@/components/Fleet/RemoteAgentMark";
import { clientErrorCode, clientErrorText } from "@/utils/clientAppError";

interface HostFleetTargetsProps {
  hostId: HostId;
  hostName: string;
}

interface Listed {
  targets: HostFleetTarget[];
  complete: boolean;
  /** When this Shell got the answer: the states in it are as of then. */
  readAt: number;
}

interface Failure {
  unsupported: boolean;
  message: string;
}

type LoadState =
  | { kind: "idle" }
  // What was on screen stays there while the host is asked again.
  | { kind: "loading"; previous: Listed | null; failure: Failure | null }
  | ({ kind: "loaded"; refreshed: boolean } & Listed)
  | ({ kind: "failed" } & Failure);

const ROW_CLASS =
  "-mx-1.5 flex min-h-7 min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 text-xs";

const STEADY_SKELETON_ROWS = ["w-1/2", "w-1/3", "w-2/5"] as const;

function ObservedState({ state }: { state: HostFleetTarget["agentState"] }) {
  // A fixed slot either way, so titles and projects keep one right edge.
  if (!state) return <span className="h-3 w-3 shrink-0" aria-hidden="true" />;
  const Icon = STATE_ICONS[state];
  return (
    <Icon
      className={cn(
        "h-3 w-3 shrink-0",
        // The host's read carries no fleet band, and amber is the band's
        // needs-you alone: a wait keeps its ring, in the neutral ink.
        state === "waiting" ? "text-text-secondary" : STATE_COLORS[state],
        state === "working" && "animate-spin-slow motion-reduce:animate-none"
      )}
      aria-hidden="true"
    />
  );
}

/** Same title in the same project twice: the host's terminal id tells them apart. */
function duplicateKeys(targets: readonly HostFleetTarget[]): Set<string> {
  const seen = new Map<string, number>();
  const keyOf = (t: HostFleetTarget) => `${t.title}\u0000${t.projectName ?? ""}`;
  for (const t of targets) seen.set(keyOf(t), (seen.get(keyOf(t)) ?? 0) + 1);
  return new Set(targets.filter((t) => (seen.get(keyOf(t)) ?? 0) > 1).map((t) => t.terminalId));
}

/**
 * Arm another host's agents into this window's fleet, so one broadcast
 * reaches agents on several machines. Listed on demand: asking costs the
 * host a terminal read, so the section opens closed and reads only when
 * opened or refreshed.
 */
export function HostFleetTargets({ hostId, hostName }: HostFleetTargetsProps) {
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [expanded, setExpanded] = useState(false);
  const armed = useArmedCrossHostTargets();
  const armedHere = armed.filter((target) => target.hostId === hostId);
  const regionId = useId();
  const allId = useId();
  // A refresh answered after a newer one must not replace it.
  const generation = useRef(0);
  const sectionRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The one Retry or Refresh on screen: where focus goes when the control the
  // person pressed is replaced by the answer (a Retry that worked, a refresh
  // that came back partial).
  const recoveryRef = useRef<HTMLButtonElement | null>(null);
  const holdFocus = useRef(false);

  const loading = state.kind === "loading";
  const listed: Listed | null =
    state.kind === "loaded" ? state : state.kind === "loading" ? state.previous : null;
  const failure: Failure | null =
    state.kind === "failed" ? state : state.kind === "loading" ? state.failure : null;
  const showSkeleton = useDeferredLoading(
    loading && listed === null && failure === null,
    UI_DOHERTY_THRESHOLD
  );

  useLayoutEffect(() => {
    if (!holdFocus.current || state.kind === "loading") return;
    holdFocus.current = false;
    // Only a control the answer took away is replaced; focus the person moved
    // elsewhere while waiting stays where they put it.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    (recoveryRef.current ?? triggerRef.current)?.focus({ preventScroll: true });
  }, [state]);

  const load = () => {
    const run = ++generation.current;
    holdFocus.current = sectionRef.current?.contains(document.activeElement) ?? false;
    setState((prev) => ({
      kind: "loading",
      previous: prev.kind === "loaded" ? prev : prev.kind === "loading" ? prev.previous : null,
      failure: prev.kind === "failed" ? prev : prev.kind === "loading" ? prev.failure : null,
    }));
    window.electron.hostMetrics.listFleetTargets({ hostId }).then(
      (list) => {
        if (run !== generation.current) return;
        setState((prev) => ({
          kind: "loaded",
          refreshed: prev.kind === "loading" && prev.previous !== null,
          targets: list.targets,
          complete: list.complete,
          readAt: Date.now(),
        }));
      },
      (error: unknown) => {
        if (run !== generation.current) return;
        setState({
          kind: "failed",
          unsupported: clientErrorCode(error) === "UNSUPPORTED",
          message: clientErrorText(error, ""),
        });
      }
    );
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && state.kind === "idle") load();
  };

  const armedKeys = new Set(armed.map((target) => target.key));
  const targets = listed?.targets ?? [];
  const armedListed = targets.filter((t) =>
    armedKeys.has(crossHostTargetKey(hostId, t.terminalId))
  ).length;
  const duplicates = duplicateKeys(targets);

  const arm = (target: HostFleetTarget) =>
    armCrossHostTarget({
      hostId,
      hostName,
      terminalId: target.terminalId,
      title: target.title,
      agentId: target.agentId,
      projectName: target.projectName,
    });

  const toggleAll = () => {
    if (armedListed === targets.length) {
      for (const t of targets) disarmCrossHostTarget(crossHostTargetKey(hostId, t.terminalId));
    } else {
      for (const t of targets) arm(t);
    }
  };

  const announcement = !expanded
    ? ""
    : state.kind === "loading"
      ? `${listed ? "Refreshing" : "Listing"} agents on ${hostName}`
      : state.kind === "failed"
        ? state.unsupported
          ? `${hostName} can't list its agents`
          : `Couldn't list agents on ${hostName}`
        : listed
          ? `${state.kind === "loaded" && state.refreshed ? "Refreshed. " : ""}${
              targets.length === 0 ? "No agents" : pluralize(targets.length, "agent")
            } on ${hostName}${listed.complete ? "" : ", not every agent could be read"}`
          : "";

  const retry = (
    <Button ref={recoveryRef} variant="outline" size="xs" onClick={load} loading={loading}>
      <RefreshCw aria-hidden="true" />
      Retry
    </Button>
  );
  const refresh = (
    <Button
      ref={recoveryRef}
      variant="ghost"
      size="icon-xs"
      onClick={load}
      loading={loading}
      aria-label={`Refresh agents on ${hostName}`}
      // The icon lines up with the rows' state glyphs.
      className="-mr-1.5"
    >
      <RefreshCw aria-hidden="true" />
    </Button>
  );

  return (
    <section
      ref={sectionRef}
      aria-labelledby={`${regionId}-heading`}
      data-testid="host-fleet-targets"
    >
      <div className="flex min-w-0 items-center gap-2">
        <h4 id={`${regionId}-heading`} className="min-w-0">
          <button
            ref={triggerRef}
            type="button"
            onClick={toggle}
            aria-expanded={expanded}
            aria-controls={regionId}
            // Every host card has one: the name says whose agents.
            aria-label={`Add agents on ${hostName} to the fleet`}
            className={cn(
              "-mx-1.5 flex min-w-0 items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-1 text-left text-xs font-medium text-text-primary",
              "transition-colors hover:bg-overlay-subtle",
              "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline"
            )}
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-text-secondary transition-transform",
                expanded && "rotate-90"
              )}
              aria-hidden="true"
            />
            <span className="truncate">Add agents to fleet</span>
          </button>
        </h4>
        {armedHere.length > 0 && (
          <span className="ml-auto shrink-0 text-2xs tabular-nums text-text-secondary">
            {armedHere.length} in this window's fleet
          </span>
        )}
      </div>
      <span role="status" className="sr-only">
        {announcement}
      </span>

      <div id={regionId} hidden={!expanded} className="mt-1 flex flex-col gap-1.5">
        {showSkeleton && (
          <>
            <Skeleton label={`Listing agents on ${hostName}`} inert className="flex flex-col">
              {STEADY_SKELETON_ROWS.map((width) => (
                <div key={width} className={ROW_CLASS}>
                  <SkeletonBone immediate className="h-3.5 w-3.5 shrink-0" />
                  <SkeletonBone immediate className="h-3.5 w-3.5 shrink-0 rounded-full" />
                  <SkeletonBone immediate className={cn("h-3", width)} />
                  <SkeletonBone immediate className="ml-auto h-3 w-14 shrink-0" />
                  <SkeletonBone immediate className="h-3 w-3 shrink-0 rounded-full" />
                </div>
              ))}
            </Skeleton>
            <p className="flex items-center gap-1 text-2xs text-text-secondary">
              Listing agents on {hostName}…
            </p>
            <SkeletonHint firstThreshold={5000} className="text-2xs" />
          </>
        )}

        {/* The card is the host's own, so titles leave its name to the body. */}
        {failure &&
          (failure.unsupported ? (
            <Callout severity="info" size="compact" title={`${hostName} can't list its agents`}>
              Update Daintree on {hostName} to add its agents to this window's fleet
            </Callout>
          ) : (
            <Callout
              severity="error"
              size="compact"
              title={
                <>
                  Couldn't list agents on <span className="whitespace-nowrap">{hostName}</span>
                </>
              }
              action={retry}
            >
              {failure.message || undefined}
            </Callout>
          ))}

        {listed && !listed.complete && (
          <Callout
            severity="warning"
            size="compact"
            title={targets.length > 0 ? "Couldn't see every agent" : "Couldn't see any agents"}
            action={retry}
          >
            {targets.length > 0 ? (
              "Some may be missing from this list"
            ) : (
              <>
                Some may still be running on <span className="whitespace-nowrap">{hostName}</span>
              </>
            )}
          </Callout>
        )}

        {listed && listed.complete && targets.length === 0 && (
          <div className="flex min-w-0 items-center gap-2 text-xs text-text-secondary">
            <span className="min-w-0 flex-1">No agents found on {hostName}</span>
            {refresh}
          </div>
        )}

        {listed && targets.length > 0 && (
          <div role="group" aria-label={`Agents on ${hostName}`} className="flex flex-col">
            <div className="flex min-w-0 items-center gap-2">
              {targets.length > 1 ? (
                <label htmlFor={allId} className={cn(ROW_CLASS, "flex-1 cursor-pointer")}>
                  <Checkbox
                    id={allId}
                    size="sm"
                    checked={
                      armedListed === 0
                        ? false
                        : armedListed === targets.length
                          ? true
                          : "indeterminate"
                    }
                    onCheckedChange={toggleAll}
                    aria-label={`All agents on ${hostName}`}
                  />
                  <span className="text-text-secondary">
                    All {pluralize(targets.length, "agent")}
                  </span>
                </label>
              ) : (
                <span className={cn(ROW_CLASS, "flex-1 text-text-secondary")}>
                  {/* Where a select-all would sit, so the label keeps the rows' text column. */}
                  <span className="w-3.5 shrink-0" aria-hidden="true" />1 agent
                </span>
              )}
              <span className="shrink-0 text-2xs text-text-secondary">
                <TimeAgo timestamp={listed.readAt} prefix="Observed " />
              </span>
              {listed.complete && refresh}
            </div>
            <ul className="flex flex-col">
              {targets.map((target) => {
                const key = crossHostTargetKey(hostId, target.terminalId);
                const checked = armedKeys.has(key);
                const inputId = `${regionId}-${target.terminalId}`;
                const disambiguator = duplicates.has(target.terminalId)
                  ? shortTerminalId(target.terminalId)
                  : null;
                const spoken = [
                  target.title,
                  disambiguator ? `(${disambiguator})` : null,
                  target.projectName ? `in ${target.projectName}` : null,
                  `on ${hostName}`,
                  target.agentState ? `, observed ${STATE_LABELS[target.agentState]}` : null,
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <li key={key}>
                    <label
                      htmlFor={inputId}
                      className={cn(
                        ROW_CLASS,
                        "cursor-pointer transition-colors hover:bg-overlay-subtle"
                      )}
                    >
                      <Checkbox
                        id={inputId}
                        size="sm"
                        checked={checked}
                        aria-label={spoken}
                        onCheckedChange={(next) => {
                          if (next === true) arm(target);
                          else disarmCrossHostTarget(key);
                        }}
                      />
                      <RemoteAgentMark agentId={target.agentId} />
                      {/* Not a tab stop: the checkbox's name already carries the full title. */}
                      <TruncatedTooltip content={target.title} focusable={false}>
                        <span className="min-w-0 flex-1 truncate text-text-primary">
                          {target.title}
                        </span>
                      </TruncatedTooltip>
                      {disambiguator && (
                        <span className="shrink-0 font-mono text-2xs text-text-secondary">
                          {disambiguator}
                        </span>
                      )}
                      {target.projectName && (
                        <TruncatedTooltip content={target.projectName} focusable={false}>
                          <span className="min-w-0 max-w-[40%] shrink truncate text-2xs text-text-secondary">
                            {target.projectName}
                          </span>
                        </TruncatedTooltip>
                      )}
                      <ObservedState state={target.agentState} />
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
