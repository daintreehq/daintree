import type { CanopySnapshot } from "@shared/types/ipc/canopy";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A read's time as the bar shows it: milliseconds under a second, else tenths. */
export function formatLinkMs(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

/** Bytes as a download shows them: whole megabytes past ten, else one decimal. */
export function formatModelBytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** What the inbox says of its model while it can't read yet; null once it can. */
export function canopyModelHoldUp(model: CanopySnapshot["model"]): string | null {
  if (!model) return null;
  if (model.status === "downloading") {
    return `Downloading the model… ${formatModelBytes(model.received)} of ${formatModelBytes(model.total)}`;
  }
  if (model.status === "failed") return "Couldn't download the model";
  if (model.status === "missing") return "Waiting for the model to download…";
  return null;
}

/**
 * The inbox's footer: what Canopy's local reader is doing, for anyone who
 * wants to know and nothing anyone has to act on. One fixed-height row in
 * secondary ink, so its readings change in place and never move the list
 * above it. The mark is filled and pulses gently while screens are being
 * read, and goes hollow once they are all done, as the app sidebar's readout does.
 *
 * A hold-up — the model still downloading, a read waiting to be tried again —
 * takes the readings' place, said where the rest of the reader's state is,
 * not over the inbox's own controls.
 */
export function CanopyStatusBar({
  host = null,
  onRetryModel,
  reader,
  model,
  waiting,
}: {
  /** The other host whose reader this is; null for this computer's own. */
  host?: string | null;
  /** Tries the model's download again, on the host it failed on. */
  onRetryModel?: () => void;
  reader: CanopySnapshot["reader"];
  model: CanopySnapshot["model"];
  waiting: CanopySnapshot["waiting"];
}) {
  const holdUp = canopyModelHoldUp(model) ?? (waiting === "retrying" ? "Waiting to retry…" : null);
  const working = (reader?.inFlight ?? 0) > 0;

  return (
    <div
      data-canopy-status=""
      className="flex h-7 shrink-0 items-center gap-2 border-t border-divider px-3 text-2xs font-medium tabular-nums text-text-secondary"
    >
      {reader && (
        <>
          <span className="flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden="true">
            <span
              data-working={working ? "true" : "false"}
              className={cn(
                "status-mark inline-flex h-2 w-2 rounded-full",
                working
                  ? "animate-pulse bg-text-secondary reduce-motion:animate-none"
                  : "border border-text-secondary"
              )}
            />
          </span>
          <span className="min-w-0 truncate">
            {reader.model} model, on {host ?? "this computer"}
          </span>
        </>
      )}
      {/* A hold-up is read out by the status line below: once is enough. */}
      <span className="ml-auto shrink-0 whitespace-nowrap" aria-hidden={holdUp ? true : undefined}>
        {holdUp ?? (reader?.readMs != null ? `${formatLinkMs(reader.readMs)} a screen` : null)}
      </span>
      {model?.status === "failed" && onRetryModel && (
        <Button variant="link" size="xs" className="h-auto shrink-0 p-0" onClick={onRetryModel}>
          Retry
        </Button>
      )}
      {/* Only a hold-up is announced: the readings change with every screen. */}
      <span role="status" className="sr-only">
        {holdUp ?? ""}
      </span>
    </div>
  );
}
