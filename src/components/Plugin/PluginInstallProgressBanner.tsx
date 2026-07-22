import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { useDeferredLoading } from "@/hooks";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import type { PluginInstallPhase, PluginInstallProgressEvent } from "@shared/types/plugin";

const PHASE_TITLES: Record<PluginInstallPhase, string> = {
  downloading: "Downloading the plugin",
  extracting: "Unpacking the plugin",
  validating: "Checking the plugin",
  activating: "Finishing the install",
};

/** Longest entry path shown before the middle is elided. */
const MAX_ENTRY_CHARS = 48;

/**
 * Keep the tail of a long archive path — the filename is what identifies the
 * entry, and a left-truncated path is unreadable. Elides the middle so the
 * top-level directory still anchors it.
 */
function truncateEntry(entry: string): string {
  if (entry.length <= MAX_ENTRY_CHARS) return entry;
  const tail = entry.slice(-(MAX_ENTRY_CHARS - 12));
  return `${entry.slice(0, 9)}…${tail}`;
}

/** Past this, name the wait explicitly rather than leaving a phase sitting there. */
const LONG_WAIT_MS = 5000;

interface PluginInstallProgressBannerProps {
  /** True while an install job is in flight, whether or not progress has arrived. */
  isInstalling: boolean;
  /** Latest progress push for the in-flight job, or null before the first one. */
  progress: PluginInstallProgressEvent | null;
  /** True once the user has asked to cancel and main hasn't finished unwinding. */
  cancelRequested: boolean;
  onCancel: () => void;
}

/**
 * Phase + current archive entry for an in-flight install, with a cancel (#11302).
 *
 * Before this, installing reported nothing until it finished — on a slow source
 * the Plugin Manager simply sat there, which is what made the 0.27.0 extraction
 * hang read as a frozen app rather than a stuck download.
 *
 * Gated at the Doherty threshold: a local `.dntr` installs in well under 400ms
 * and flashing a banner for it would be noise. The layout is a fixed one-line
 * shape, so there's no skeleton stage — the banner either isn't warranted yet or
 * has real content to show. Past five seconds it says so, since `validating` and
 * `activating` carry no entry line and would otherwise look stalled.
 *
 * Neutral severity, no accent: this is ambient progress, not a focus anchor or a
 * problem. `aria-live` is off on purpose — `InlineStatusBanner` announces
 * atomically, so a polite region would re-read the whole banner every time the
 * archive entry changes (~150ms). Announcing a fragment of a file path several
 * times a second is worse than announcing nothing; the outcome of the install is
 * still surfaced by the error/notice region the Plugin Manager already owns.
 */
export function PluginInstallProgressBanner({
  isInstalling,
  progress,
  cancelRequested,
  onCancel,
}: PluginInstallProgressBannerProps) {
  const show = useDeferredLoading(isInstalling, UI_DOHERTY_THRESHOLD);
  const [longWait, setLongWait] = useState(false);

  useEffect(() => {
    if (!isInstalling) {
      setLongWait(false);
      return;
    }
    const timer = setTimeout(() => setLongWait(true), LONG_WAIT_MS);
    return () => clearTimeout(timer);
  }, [isInstalling]);

  if (!show) return null;

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
  const entryLine = phase === "extracting" && progress?.entry ? truncateEntry(progress.entry) : "";

  return (
    <InlineStatusBanner
      icon={Download}
      severity="neutral"
      title={title}
      description={longWait && !cancelRequested ? "Still working…" : undefined}
      contextLine={entryLine}
      role="status"
      ariaLive="off"
      animated
      actions={[
        {
          id: "cancel-install",
          label: "Cancel install",
          variant: "dismiss",
          onClick: onCancel,
          // No tooltip on the disabled state: a native disabled button takes no
          // pointer events and no focus, so the tooltip would be unreachable —
          // the "Finishing the install" title already says why it's off.
          disabled: !cancellable || cancelRequested,
        },
      ]}
    />
  );
}
