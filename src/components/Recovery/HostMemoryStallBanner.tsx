import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { HOST_MEMORY_PAUSE_COPY } from "@/lib/hostMemoryPauseCopy";
import { actionService } from "@/services/ActionService";
import { useHostMemoryPauseStore } from "@/store/hostMemoryPauseStore";

/**
 * Escalation for a terminal-host memory pause that isn't recovering (#12375):
 * the episode has stayed open past the stall bound, because the governor keeps
 * re-pausing or force-resumed while the host still reports high memory. The
 * normal pause and resume never reach this — they stay on the toolbar
 * indicator. Not dismissible: it clears itself when the episode closes.
 */
export function HostMemoryStallBanner() {
  const stalled = useHostMemoryPauseStore((s) => s.snapshot?.stalled ?? false);

  if (!stalled) return null;

  const { title, description, action } = HOST_MEMORY_PAUSE_COPY.stall;

  return (
    <InlineStatusBanner
      title={title}
      description={description}
      severity="warning"
      role="status"
      actions={[
        {
          id: "why-slow",
          label: action,
          variant: "primary",
          onClick: () =>
            void actionService.dispatch("diagnostics.openWhySlow", undefined, { source: "user" }),
        },
      ]}
    />
  );
}
