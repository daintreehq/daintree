import { Suspense } from "react";
import { cn } from "@/lib/utils";
import { lazyWithPreload } from "@/lib/lazyWithPreload";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

// One width for every state the slot shows — placeholder, locked, elsewhere,
// and the mic with its waveform — so starting or ending a session never moves
// the right-aligned items.
export const VOICE_SLOT_CLASS = "h-8 w-11";

export function VoiceRecordingPlaceholder() {
  // Reserves the slot footprint so right-aligned toolbar items don't shift
  // when a session starts/stops. Matches DevServerPlaceholder's pattern.
  // No data-toolbar-item — the placeholder is non-interactive and must not
  // appear in the toolbar's roving tabindex (Toolbar.getToolbarItems filters
  // by offsetParent, which opacity-0 does NOT null out).
  return (
    <div
      className={cn("toolbar-icon-button relative opacity-0 pointer-events-none", VOICE_SLOT_CLASS)}
      aria-hidden="true"
    />
  );
}

const LazyVoiceRecordingToolbarButton = lazyWithPreload(
  () => import("./VoiceRecordingToolbarButton"),
  (mod) => mod.VoiceRecordingToolbarButton
);

/**
 * The toolbar's voice slot. With dictation off here and nothing to show, it
 * is the placeholder alone; the button, its session panels and the service
 * they drive load once dictation is configured or a session or lock appears.
 */
export function VoiceRecordingToolbarSlot({
  "data-toolbar-item": dataToolbarItem,
}: {
  "data-toolbar-item"?: string;
}) {
  const wanted = useVoiceRecordingStore(
    (state) =>
      state.isConfigured ||
      state.activeTarget !== null ||
      state.pendingTarget !== null ||
      state.lockedTarget !== null ||
      state.sessionElsewhere !== null
  );
  if (!wanted) return <VoiceRecordingPlaceholder />;
  return (
    <Suspense fallback={<VoiceRecordingPlaceholder />}>
      <LazyVoiceRecordingToolbarButton data-toolbar-item={dataToolbarItem} />
    </Suspense>
  );
}
