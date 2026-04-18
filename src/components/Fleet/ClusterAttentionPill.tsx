import { type ReactElement } from "react";
import { AlertCircle, CheckCircle2, Clock, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAgentClusters, type ClusterType } from "@/hooks/useAgentClusters";
import { useClusterAttentionStore } from "@/store/clusterAttentionStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";

const ICONS: Record<ClusterType, React.ComponentType<{ className?: string }>> = {
  prompt: Clock,
  error: AlertCircle,
  completion: CheckCircle2,
};

const ICON_CLASSES: Record<ClusterType, string> = {
  prompt: "text-state-waiting",
  error: "text-status-error",
  completion: "text-status-success",
};

export function ClusterAttentionPill(): ReactElement | null {
  const cluster = useAgentClusters();
  const isDismissed = useClusterAttentionStore((s) =>
    cluster ? s.dismissedSignatures.has(cluster.signature) : false
  );

  if (!cluster || isDismissed) return null;

  const Icon = ICONS[cluster.type];
  const iconClass = ICON_CLASSES[cluster.type];

  const handleArm = () => {
    useFleetArmingStore.getState().armIds(cluster.memberIds);
  };

  const handleDismiss = () => {
    useClusterAttentionStore.getState().dismiss(cluster.signature);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="cluster-attention-pill"
      data-cluster-type={cluster.type}
      className={cn(
        "inline-flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-full",
        "bg-surface-panel backdrop-blur-md ring-1 ring-border-strong",
        "text-xs text-daintree-text"
      )}
    >
      <Icon className={cn("h-3.5 w-3.5 shrink-0", iconClass)} aria-hidden="true" />
      <span className="font-medium">{cluster.headline}</span>
      <button
        type="button"
        onClick={handleArm}
        aria-label={`Arm ${cluster.count} ${cluster.count === 1 ? "agent" : "agents"}`}
        className={cn(
          "ml-1 inline-flex items-center rounded-full px-2 py-0.5 text-[11px]",
          "bg-daintree-accent/15 text-daintree-accent hover:bg-daintree-accent/25",
          "transition-colors",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
        )}
      >
        arm
      </button>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss cluster notification"
        className={cn(
          "rounded-full p-1 text-daintree-text/60 hover:bg-tint/[0.08] hover:text-daintree-text",
          "transition-colors",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
        )}
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  );
}
