import { Monitor } from "lucide-react";
import { SurfaceHeader } from "@/components/ui/SurfaceHeader";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { answerOptions, itemSubject, type CanopyItem } from "./canopyModel";
import { glanceDetail, rowStatus } from "./CanopyRow";

/**
 * A run on another host, as that host's Canopy read it: its words, and the
 * choices on its screen as words rather than keys. Its terminal and its reply
 * stay on the host until they can be reached from here, so nothing in this
 * pane types into the run or acts on it.
 */
export function CanopyReadingPane({
  item,
  domId,
  hostName,
  describedBy,
}: {
  item: CanopyItem;
  domId: string;
  hostName: string;
  describedBy?: string;
}) {
  const { row } = item;
  const status = rowStatus(item);
  const summary = item.card?.summary && item.card.summary !== status ? item.card.summary : null;
  const detail = summary ?? glanceDetail(item, status);
  const action = item.card?.action ?? item.glance?.action ?? null;
  const choices = answerOptions(item);
  return (
    <section
      id={domId}
      aria-label={itemSubject(item)}
      aria-describedby={describedBy}
      data-canopy-detail=""
      data-canopy-reading=""
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-overlay bg-surface shadow-[var(--theme-shadow-ambient)]"
    >
      <SurfaceHeader density="compact" className="text-xs select-none">
        <div className="flex min-w-0 flex-1 items-center gap-2 self-stretch">
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-text-primary">
            <TerminalIcon
              chrome={row.chrome}
              className="h-3.5 w-3.5"
              brandColor={row.presetColor ?? row.chrome.color}
            />
          </span>
          <span className="min-w-0 truncate font-medium text-text-primary">{row.title}</span>
        </div>
      </SurfaceHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-surface-canvas px-4 py-3 text-sm">
        <p className="text-text-primary">{status}</p>
        {detail && <p className="text-text-secondary">{detail}</p>}
        {action && (
          <p className="font-mono text-xs break-words whitespace-pre-wrap text-text-primary">
            {action}
          </p>
        )}
        {choices.length > 0 && (
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-xs text-text-secondary">
            {choices.map((choice) => (
              <li key={choice}>{choice}</li>
            ))}
          </ol>
        )}
        {item.failed && (
          <p className="text-xs text-text-secondary">Read failed. This is what was read before.</p>
        )}
      </div>
      <p className="flex shrink-0 items-center gap-1.5 border-t border-border-default px-3.5 py-3 text-xs text-text-secondary">
        <Monitor className="size-3.5 shrink-0" aria-hidden="true" />
        To answer it or open its terminal, switch this window to {hostName} from the host chip
      </p>
    </section>
  );
}
