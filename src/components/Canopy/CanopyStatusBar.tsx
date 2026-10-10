import type { CanopySnapshot } from "@shared/types/ipc/canopy";
import { cn } from "@/lib/utils";

/** A request's time as the bar shows it: milliseconds under a second, else tenths. */
export function formatLinkMs(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

/**
 * The inbox's footer: what Canopy's requests to its service are doing, for
 * anyone who wants to know and nothing anyone has to act on. One fixed-height
 * row in secondary ink, so its readings change in place and never move the
 * list above it. The mark is filled and pulses gently while requests are out,
 * and goes hollow once they are all back, as the app sidebar's readout does.
 *
 * A hold-up — the service starting, a read waiting to be tried again — takes
 * the readings' place: it is why summaries are slow, said where the rest of
 * the service's state is, not over the inbox's own controls.
 */
export function CanopyStatusBar({
  link,
  waiting,
}: {
  link: CanopySnapshot["link"];
  waiting: CanopySnapshot["waiting"];
}) {
  const holdUp =
    waiting === "waking"
      ? "Starting Canopy's service…"
      : waiting === "retrying"
        ? "Waiting to retry…"
        : null;
  const working = (link?.inFlight ?? 0) > 0;
  const times = [
    link?.classifyMs != null ? `classify ${formatLinkMs(link.classifyMs)}` : null,
    link?.readMs != null ? `summary ${formatLinkMs(link.readMs)}` : null,
  ].filter((time) => time !== null);

  return (
    <div
      data-canopy-status=""
      className="flex h-7 shrink-0 items-center gap-2 border-t border-divider px-3 text-2xs font-medium tabular-nums text-text-secondary"
    >
      {link && (
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
          <span className="min-w-0 truncate">{link.host}</span>
        </>
      )}
      {/* A hold-up is read out by the status line below: once is enough. */}
      <span className="ml-auto shrink-0 whitespace-nowrap" aria-hidden={holdUp ? true : undefined}>
        {holdUp ?? (link ? [`${link.inFlight} in flight`, ...times].join(" · ") : null)}
      </span>
      {/* Only a hold-up is announced: the readings change with every request. */}
      <span role="status" className="sr-only">
        {holdUp ?? ""}
      </span>
    </div>
  );
}
