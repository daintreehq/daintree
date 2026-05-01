import { type ReactElement } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useAgentClusters, type ClusterType } from "@/hooks/useAgentClusters";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useUIStore } from "@/store";
import { AnimatedLabel } from "@/components/ui/AnimatedLabel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

function buttonLabel(type: ClusterType, count: number): string {
  switch (type) {
    case "prompt":
      return `Arm ${count} waiting`;
    case "error":
      return `Arm ${count} with errors`;
    case "completion":
      return `Arm ${count} finished`;
  }
}

function tooltipLabel(type: ClusterType, count: number): string {
  const noun = count === 1 ? "terminal" : "terminals";
  switch (type) {
    case "prompt":
      return `${count} ${noun} waiting for input`;
    case "error":
      return `${count} ${noun} exited with errors`;
    case "completion":
      return `${count} ${noun} just finished`;
  }
}

/**
 * State-driven arming suggestion. Surfaces a sticky pill at the bottom of the
 * viewport whenever the highest-priority active cluster (≥2 panes) crosses
 * threshold — prompt > error > completion. Click arms exactly the cluster's
 * members and lets the user broadcast a shared response.
 *
 * Mounting: body-portaled so position:fixed anchors to the viewport regardless
 * of any ancestor that creates a containing block via backdrop-filter or
 * transform (#2574). Always-mounted wrapper carries `pointer-events-none` so
 * mouse events pass through to terminals beneath; only the interactive button
 * itself takes `pointer-events-auto` (#3826).
 *
 * Animation: entry/exit fires only when the cluster toggles between null and
 * non-null — count or type updates swap text in place via AnimatedLabel so the
 * pill never re-enters during normal panel state churn.
 */
export function FleetSmartArmBar(): ReactElement | null {
  const cluster = useAgentClusters();
  const reduceMotion = useReducedMotion();
  // Suppress while a blocking overlay (e.g. ThemeBrowser) is open. The Toolbar
  // and FleetArmingRibbon get this for free via an `inert` ancestor in
  // AppLayout, but body-portaled surfaces sit outside that subtree and have to
  // gate themselves explicitly.
  const themeBrowserOpen = useUIStore((s) => s.overlayClaims.has("theme-browser"));
  const showCluster = cluster && !themeBrowserOpen ? cluster : null;

  const motionProps = reduceMotion
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0, transition: { duration: 0.12 } },
        transition: { duration: 0.12 },
      }
    : {
        initial: { y: 12, opacity: 0 },
        animate: { y: 0, opacity: 1 },
        exit: {
          y: 12,
          opacity: 0,
          transition: { duration: 0.12, ease: [0.4, 0, 0.2, 1] as const },
        },
        transition: { type: "spring" as const, duration: 0.2, bounce: 0.12 },
      };

  const handleArm = (): void => {
    if (!showCluster) return;
    useFleetArmingStore.getState().armIds(showCluster.memberIds);
  };

  return createPortal(
    <div
      className="pointer-events-none fixed bottom-4 left-1/2 z-[var(--z-modal)] flex -translate-x-1/2 items-center justify-center"
      data-testid="fleet-smart-arm-bar-root"
    >
      <AnimatePresence initial={false}>
        {showCluster && (
          <m.div key="fleet-smart-arm-bar" {...motionProps}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleArm}
                  data-testid="fleet-smart-arm-bar"
                  data-cluster-type={showCluster.type}
                  data-cluster-count={showCluster.count}
                  aria-label={buttonLabel(showCluster.type, showCluster.count)}
                  className={cn(
                    "pointer-events-auto inline-flex items-center gap-2 rounded-full px-4 py-2 text-[12px] text-daintree-text",
                    "bg-overlay-subtle shadow-[var(--theme-shadow-floating)] ring-1 ring-border-default",
                    "transition-colors hover:bg-overlay-medium focus:outline-hidden focus-visible:ring-2 focus-visible:ring-border-strong"
                  )}
                >
                  <AnimatedLabel
                    label={buttonLabel(showCluster.type, showCluster.count)}
                    textClassName="font-medium tabular-nums"
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {tooltipLabel(showCluster.type, showCluster.count)}
              </TooltipContent>
            </Tooltip>
          </m.div>
        )}
      </AnimatePresence>
    </div>,
    document.body
  );
}
