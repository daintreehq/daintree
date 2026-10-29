import { Spinner } from "@/components/ui/Spinner";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
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
  const text = slow ? `${label} — still working…` : label;
  return (
    // One line whatever the label: a wait in the 32px strip names an app path
    // that can be longer than the strip has room for.
    <p role="status" className="flex min-w-0 items-center gap-2 text-xs text-text-secondary">
      <Spinner size="xs" />
      <TruncatedTooltip content={text} focusable={false}>
        <span className="min-w-0 truncate">{text}</span>
      </TruncatedTooltip>
    </p>
  );
}
