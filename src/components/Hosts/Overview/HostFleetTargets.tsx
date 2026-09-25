import { useState } from "react";
import type { HostFleetTarget } from "@shared/types/ipc/hostMetrics";
import type { HostId } from "@shared/types/remoteHosts";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  armCrossHostTarget,
  crossHostTargetKey,
  disarmCrossHostTarget,
  useArmedCrossHostTargets,
} from "@/components/Fleet/crossHostFleet";

interface HostFleetTargetsProps {
  hostId: HostId;
  hostName: string;
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; targets: HostFleetTarget[] }
  | { kind: "failed"; message: string };

const STATE_LABEL: Record<NonNullable<HostFleetTarget["agentState"]>, string> = {
  idle: "idle",
  working: "working",
  waiting: "waiting",
  directing: "directing",
  completed: "completed",
  exited: "exited",
};

/**
 * Arm another host's agents into this window's fleet, so one broadcast
 * reaches agents on several machines. Listed on demand: asking costs the
 * host a terminal read.
 */
export function HostFleetTargets({ hostId, hostName }: HostFleetTargetsProps) {
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const armed = useArmedCrossHostTargets();
  const armedHere = armed.filter((target) => target.hostId === hostId).length;

  const load = () => {
    setState({ kind: "loading" });
    window.electron.hostMetrics.listFleetTargets({ hostId }).then(
      (targets) => setState({ kind: "loaded", targets }),
      (error: unknown) =>
        setState({ kind: "failed", message: formatErrorMessage(error, "Couldn't list agents") })
    );
  };

  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={load}
          disabled={state.kind === "loading"}
          aria-busy={state.kind === "loading" || undefined}
        >
          Add agents to fleet…
        </Button>
        {armedHere > 0 && (
          <span className="text-2xs text-text-secondary">{armedHere} in this window's fleet</span>
        )}
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span role="alert" className="text-status-error">
          {state.message}
        </span>
        <Button variant="ghost" size="xs" onClick={load}>
          Retry
        </Button>
      </div>
    );
  }

  if (state.targets.length === 0) {
    return <p className="text-xs text-text-secondary">No agents running on {hostName}</p>;
  }

  const armedKeys = new Set(armed.map((target) => target.key));
  return (
    <ul className="flex flex-col gap-1" aria-label={`Agents on ${hostName}`}>
      {state.targets.map((target) => {
        const key = crossHostTargetKey(hostId, target.terminalId);
        const checked = armedKeys.has(key);
        const where = target.projectName ? ` · ${target.projectName}` : "";
        const observed = target.agentState ? ` · ${STATE_LABEL[target.agentState]} (observed)` : "";
        return (
          <li key={key} className="flex min-w-0 items-center gap-2 text-xs">
            <Checkbox
              size="sm"
              checked={checked}
              aria-label={`Include ${target.title} on ${hostName} in the fleet`}
              onCheckedChange={(next) => {
                if (next === true) {
                  armCrossHostTarget({
                    hostId,
                    hostName,
                    terminalId: target.terminalId,
                    title: target.title,
                  });
                } else {
                  disarmCrossHostTarget(key);
                }
              }}
            />
            <span className="min-w-0 truncate text-text-primary">{target.title}</span>
            <span className="min-w-0 truncate text-text-secondary">
              {where}
              {observed}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
