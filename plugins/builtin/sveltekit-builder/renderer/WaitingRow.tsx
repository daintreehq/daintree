import { Spinner } from "@/components/ui/Spinner";
import { useDeferredLoading, useDohertyGate } from "@/hooks/useDeferredLoading";
import { UI_STILL_WORKING_MS } from "@/lib/animationUtils";

/**
 * An inline wait of unknown length. Nothing under the Doherty gate, then a
 * spinner with its label, then "Still working…" once it has run long enough to
 * look stuck. A spinner rather than a skeleton: this row has no layout to stand in for.
 */
export function WaitingRow({ label }: { label: string }) {
  const visible = useDohertyGate(true);
  const slow = useDeferredLoading(true, UI_STILL_WORKING_MS);
  if (!visible) return null;
  return (
    <p role="status" className="flex items-center gap-2 text-xs text-text-secondary">
      <Spinner size="xs" />
      {slow ? `${label} — still working…` : label}
    </p>
  );
}
