import { useEffect, useState } from "react";
import { CircleDashed, CircleHelp, CircleMinus, LoaderCircle, type LucideIcon } from "lucide-react";
import type { DeploymentState, DeploymentTarget } from "@shared/types/forge";
import type { ForgeDeployment } from "@shared/types/ipc/forge";
import { linkHost } from "@shared/utils/projectLinks";
import { forgeClient } from "@/clients/forgeClient";
import { FactRun } from "@/components/ui/FactSeparator";
import { LIST_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { safeDetailsUrl, sanitizeCheckSource } from "@/components/Worktree/ReviewHub/prChecks";
import type { LauncherDeploymentTarget } from "@/hooks/useLinksLauncher";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import { LinksLauncherRow } from "./LinksLauncherRow";

export const DEPLOYMENTS_HEADING = "Deployments";

/** What the launcher knows of the active worktree's deployments for this opening. */
export type LauncherDeployments =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; rows: LauncherDeploymentRow[] }
  | { kind: "error" };

const IDLE: LauncherDeployments = { kind: "idle" };
const LOADING: LauncherDeployments = { kind: "loading" };
const ERROR: LauncherDeployments = { kind: "error" };

export interface DeploymentStateVisual {
  Icon: LucideIcon;
  toneClass: string;
  /** Painted beside the environment and read into the row's description. */
  label: string;
}

/**
 * Every state keeps its glyph, since shape is all that survives forced
 * colours. A live deployment reads like a running check beside it. A finished
 * or failed one wears its severity's glyph, but a successful one keeps neutral
 * ink: on a list opened again and again, "Deployed" is the ordinary case, not
 * a result to celebrate.
 */
const STATE_VISUAL: Record<DeploymentState, DeploymentStateVisual> = {
  pending: { Icon: CircleDashed, toneClass: "text-text-secondary", label: "Pending" },
  in_progress: { Icon: LoaderCircle, toneClass: "text-status-warning", label: "Deploying" },
  success: { Icon: SEVERITY_GLYPH.success, toneClass: "text-text-secondary", label: "Deployed" },
  failure: { Icon: SEVERITY_GLYPH.error, toneClass: "text-status-error", label: "Failed" },
  inactive: { Icon: CircleMinus, toneClass: "text-text-secondary", label: "Inactive" },
  unknown: { Icon: CircleHelp, toneClass: "text-text-secondary", label: "Unknown state" },
};

export interface LauncherDeploymentRow {
  /** The environment exactly as the forge records it: what tells two apart. */
  environment: string;
  /** The environment's name cleaned for the screen. */
  name: string;
  state: DeploymentStateVisual;
  /** The latest deployment's own address. Absent when it reported none. */
  url?: string;
}

/**
 * One row per environment, from its newest deployment alone: the state and
 * the address always come from the same record, so a rollout still in flight
 * never borrows the address of the one it is replacing. Environments keep the
 * order of their newest deployments.
 */
export function latestLauncherDeployments(
  deployments: readonly ForgeDeployment[]
): LauncherDeploymentRow[] {
  // A stable sort: the host's order stands for deployments created together.
  const newestFirst = [...deployments].sort((a, b) => b.createdAt - a.createdAt);
  const seen = new Set<string>();
  const rows: LauncherDeploymentRow[] = [];
  for (const deployment of newestFirst) {
    if (seen.has(deployment.environment)) continue;
    seen.add(deployment.environment);
    const url = safeDetailsUrl(deployment.url);
    rows.push({
      environment: deployment.environment,
      // Whoever can deploy names the environment, so it is cleaned like a check name.
      name: sanitizeCheckSource(deployment.environment) ?? "Unnamed environment",
      state: STATE_VISUAL[deployment.state],
      ...(url !== undefined ? { url } : {}),
    });
  }
  return rows;
}

/**
 * Reads the active worktree's deployments once per opening of the launcher
 * (`seq`), the way its pull request's checks are read: nothing polls, and a
 * read made for one opening or target never paints under another, nor under
 * the same one selected again. `seq` is `null` while this host's launcher is
 * closed. A target the forge says doesn't exist has nothing deployed.
 */
export function useLauncherDeployments(
  target: LauncherDeploymentTarget | null,
  seq: number | null
): LauncherDeployments {
  const path = target?.worktreePath ?? null;
  const prNumber = target?.kind === "pullRequest" ? target.prNumber : null;
  const branch = target?.kind === "branch" ? target.branch : null;
  const key =
    seq === null || target === null
      ? null
      : [
          seq,
          target.providerId,
          target.worktreeId,
          path,
          prNumber,
          branch,
          target.kind === "pullRequest" ? target.prUrl : null,
        ].join("\u0000");
  const [result, setResult] = useState<{ key: string; deployments: LauncherDeployments } | null>(
    null
  );
  // Dropped whenever the key moves, so coming back to a target within one
  // opening waits for its new read instead of repainting the old one.
  const [readFor, setReadFor] = useState(key);
  if (readFor !== key) {
    setReadFor(key);
    setResult(null);
  }

  useEffect(() => {
    if (key === null || path === null) return;
    const request: DeploymentTarget | null =
      prNumber !== null
        ? { kind: "pullRequest", prNumber }
        : branch !== null
          ? { kind: "branch", branch }
          : null;
    if (request === null) return;
    let live = true;
    // StrictMode replays this effect inside one commit; starting a microtask
    // later lets only the run that stays mounted ask the forge.
    queueMicrotask(() => {
      if (!live) return;
      forgeClient.getDeployments(path, request).then(
        (response) => {
          if (!live) return;
          setResult({
            key,
            deployments: {
              kind: "loaded",
              rows: response === null ? [] : latestLauncherDeployments(response.deployments),
            },
          });
        },
        () => {
          if (live) setResult({ key, deployments: ERROR });
        }
      );
    });
    return () => {
      live = false;
    };
  }, [key, path, prNumber, branch]);

  if (key === null) return IDLE;
  return result?.key === key ? result.deployments : LOADING;
}

/**
 * Whether the deployments section has anything to show: a deployment, a
 * failed read to own up to, or a skeleton that is up. Nothing deployed shows
 * nothing at all.
 */
export function showsDeployments(deployments: LauncherDeployments, showSkeleton: boolean): boolean {
  if (showSkeleton || deployments.kind === "error") return true;
  return deployments.kind === "loaded" && deployments.rows.length > 0;
}

/**
 * Where the active worktree is deployed (#17255): each environment the forge
 * reported, with its latest state, opening its address in the system browser.
 */
export function LinksLauncherDeployments({
  worktreeLabel,
  deployments,
  showSkeleton,
  sectionId,
  onOpen,
}: {
  worktreeLabel: string;
  deployments: LauncherDeployments;
  showSkeleton: boolean;
  sectionId: string;
  onOpen: (url: string) => void;
}) {
  const headingId = `${sectionId}-heading`;
  const rows = deployments.kind === "loaded" && !showSkeleton ? deployments.rows : [];
  const failed = deployments.kind === "error" && !showSkeleton;
  const shown = showsDeployments(deployments, showSkeleton);
  return (
    // Mounted while there is a target, so a failure landing later is announced
    // from inside the section; out of the list's flow until there is
    // something to show, so an empty answer leaves no gap.
    <section
      aria-labelledby={shown ? headingId : undefined}
      className={shown ? undefined : "sr-only"}
    >
      {shown && (
        <h2 id={headingId} className="flex min-w-0 items-baseline gap-2 px-3 pt-1.5 pb-1">
          <span className={cn(LIST_LABEL_CLASS, "shrink-0")}>{DEPLOYMENTS_HEADING}</span>{" "}
          <span className="min-w-0 truncate text-xs text-text-secondary">{worktreeLabel}</span>
        </h2>
      )}
      {rows.length > 0 && (
        <ul className="flex flex-col">
          {rows.map((row, index) => (
            <LinksLauncherRow
              key={row.environment}
              rowId={`${sectionId}-${index}`}
              icon={
                <row.state.Icon
                  className={cn("h-4 w-4 shrink-0", row.state.toneClass)}
                  aria-hidden="true"
                />
              }
              title={row.name}
              detail={
                row.url === undefined ? (
                  row.state.label
                ) : (
                  <FactRun facts={[row.state.label, linkHost(row.url)]} />
                )
              }
              url={row.url}
              external
              onOpen={onOpen}
              onOpenExternal={onOpen}
            />
          ))}
        </ul>
      )}
      {showSkeleton && (
        <Skeleton label="Loading deployments" className="flex flex-col gap-3 px-3 pt-1.5 pb-3">
          <div className="flex items-center gap-2.5">
            <SkeletonBone immediate className="h-4 w-4 rounded-full" />
            <SkeletonBone immediate className="h-2.5 w-2/3" />
          </div>
        </Skeleton>
      )}
      <div role="status" aria-live="polite">
        {failed && (
          <p className="px-3 pb-2 text-xs text-text-secondary">Couldn't load deployments</p>
        )}
      </div>
    </section>
  );
}
