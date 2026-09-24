import { useEffect, useId, useState } from "react";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/Spinner";
import { useDeferredLoading } from "@/hooks";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import type { PluginInstallPhase, PluginInstallProgressEvent } from "@shared/types/plugin";

const PHASE_TITLES: Record<PluginInstallPhase, string> = {
  downloading: "Downloading the plugin",
  extracting: "Unpacking the plugin",
  validating: "Checking the plugin",
  activating: "Finishing the install",
};

/** Past this, name the wait explicitly rather than leaving a phase sitting there. */
const LONG_WAIT_MS = 5000;

interface PluginInstallProgressBannerProps {
  /** True while an install job is in flight, whether or not progress has arrived. */
  isInstalling: boolean;
  /** Latest progress push for the in-flight job, or null before the first one. */
  progress: PluginInstallProgressEvent | null;
  /** The archive file name or URL being installed, when known. */
  source: string | null;
  /** True once the user has asked to cancel and main hasn't finished unwinding. */
  cancelRequested: boolean;
  onCancel: () => void;
}

/**
 * Phase, source and current archive entry for an in-flight install, with a
 * cancel (#11302).
 *
 * Before this, installing reported nothing until it finished — on a slow source
 * the Plugin Manager simply sat there, which is what made the 0.27.0 extraction
 * hang read as a frozen app rather than a stuck download.
 *
 * Gated at the Doherty threshold: a local `.dntr` installs in well under 400ms
 * and flashing a banner for it would be noise. Past the gate the glyph spins for
 * as long as the job is open, since an unchanging title is exactly what reads as
 * hung. The shape holds still for the whole install: the title names the step,
 * the mono line beneath it names what is being installed (or, while unpacking,
 * the entry being written), and the notes and Cancel share one trailing cluster
 * — so a phase change, the five-second note or the commit point never moves the
 * list below or the Cancel target.
 *
 * Neutral severity, no accent: this is ambient progress, not a focus anchor or a
 * problem. `aria-live` is off on the banner itself — `InlineStatusBanner`
 * announces atomically, so a polite banner would re-read the whole thing every
 * time the archive entry changes (~150ms). Step changes are announced through a
 * separate region that carries the title alone; the outcome of the install is
 * still surfaced by the error/notice region the Plugin Manager already owns.
 */
export function PluginInstallProgressBanner({
  isInstalling,
  progress,
  source,
  cancelRequested,
  onCancel,
}: PluginInstallProgressBannerProps) {
  const show = useDeferredLoading(isInstalling, UI_DOHERTY_THRESHOLD);
  const [longWait, setLongWait] = useState(false);
  const noteId = useId();

  useEffect(() => {
    if (!isInstalling) {
      setLongWait(false);
      return;
    }
    const timer = setTimeout(() => setLongWait(true), LONG_WAIT_MS);
    return () => clearTimeout(timer);
  }, [isInstalling]);

  // No event yet: the install has been dispatched but main hasn't reached its
  // first phase. Name the step that is actually happening rather than inventing
  // a phase the installer might skip.
  const phase = progress?.phase;
  const title = cancelRequested
    ? "Cancelling the install"
    : phase
      ? PHASE_TITLES[phase]
      : "Installing the plugin";
  // `cancellable` is authoritative and false past the commit point. Absent an
  // event we assume cancellable — the install can't have committed yet, and main
  // rejects a cancel it can't honour anyway.
  const cancellable = progress?.cancellable ?? true;
  const canCancel = cancellable && !cancelRequested;
  // The entry belongs to the phase that wrote it: once the user cancels, a
  // filename still ticking over would read as the unpack carrying on.
  const detail =
    phase === "extracting" && progress?.entry && !cancelRequested
      ? progress.entry
      : (source ?? undefined);
  // "Cancelling the install" already explains an inert Cancel; past the commit
  // point nothing else would.
  const note = cancelRequested
    ? null
    : !cancellable
      ? "Can't be cancelled now"
      : longWait
        ? "Still working…"
        : null;

  return (
    <>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {show ? title : ""}
      </p>
      {show && (
        <InlineStatusBanner
          icon={Spinner}
          severity="neutral"
          layout="pane"
          title={title}
          contextLine={detail}
          contextLineTruncate="middle"
          role="status"
          ariaLive="off"
          animated
          className="border-b border-divider"
          trailingSlot={
            <>
              {note && (
                <span id={noteId} className="px-1 text-xs whitespace-nowrap text-text-secondary">
                  {note}
                </span>
              )}
              {/* `aria-disabled`, not `disabled`: a native disabled button drops
                  keyboard focus to <body> the moment the install passes its
                  commit point, and takes the reason with it. */}
              <Button
                variant="ghost"
                size="sm"
                aria-disabled={!canCancel || undefined}
                aria-describedby={note && !canCancel ? noteId : undefined}
                onClick={canCancel ? onCancel : undefined}
                className="aria-disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent aria-disabled:hover:text-text-secondary"
              >
                Cancel install
              </Button>
            </>
          }
        />
      )}
    </>
  );
}
