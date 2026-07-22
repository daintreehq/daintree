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

interface PluginInstallProgressBannerProps {
  /** True while an install call is in flight, whether or not progress has arrived. */
  isInstalling: boolean;
  /** Latest progress push for the in-flight job, or null before the first one. */
  progress: PluginInstallProgressEvent | null;
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
 * has real content to show.
 *
 * Neutral severity, no accent: this is ambient progress, not a focus anchor or a
 * problem. The live region announces phase changes only — the entry line churns
 * every ~150ms and reading it aloud would be unusable.
 */
export function PluginInstallProgressBanner({
  isInstalling,
  progress,
  onCancel,
}: PluginInstallProgressBannerProps) {
  const show = useDeferredLoading(isInstalling, UI_DOHERTY_THRESHOLD);
  if (!show) return null;

  // No event yet: the install has been dispatched but main hasn't reached its
  // first phase. Name the step that is actually happening rather than inventing
  // a phase the installer might skip.
  const phase = progress?.phase;
  const title = phase ? PHASE_TITLES[phase] : "Installing the plugin";
  // `cancellable` is authoritative and false past the commit point. Absent an
  // event we assume cancellable — the install can't have committed yet.
  const cancellable = progress?.cancellable ?? true;

  return (
    <InlineStatusBanner
      icon={Download}
      severity="neutral"
      title={title}
      contextLine={phase === "extracting" && progress?.entry ? truncateEntry(progress.entry) : ""}
      role="status"
      ariaLive="polite"
      animated
      actions={[
        {
          id: "cancel-install",
          label: "Cancel install",
          variant: "dismiss",
          onClick: onCancel,
          disabled: !cancellable,
          title: cancellable ? undefined : "Too late to cancel — the install is being finalised",
        },
      ]}
    />
  );
}
