import { create } from "zustand";
import { systemClient } from "@/clients";
import { formatErrorMessage } from "@shared/utils/errorMessage";

export type RendererCpuProfilePhase = "idle" | "starting" | "recording" | "saving";

interface RendererCpuProfileState {
  phase: RendererCpuProfilePhase;
  /** Main's auto-stop deadline (epoch ms) for the current recording, 0 when none. */
  expiresAt: number;
  error: string | null;
  record: () => Promise<void>;
  /**
   * Collects the recording: stops it early, or takes the capture Main already
   * made at the deadline, then shows the save dialog.
   */
  collect: () => Promise<void>;
}

// Main keys a recording to this view's webContents and keeps an auto-stopped
// capture until it is collected. The Troubleshooting row unmounts whenever
// Settings closes, which is how a slow interaction gets reproduced, so the
// recording outlives it here and a reopened row can still offer the capture.
export const useRendererCpuProfileStore = create<RendererCpuProfileState>()((set, get) => ({
  phase: "idle",
  expiresAt: 0,
  error: null,

  record: async () => {
    // A lagging renderer is why this control gets used, so a second click often
    // lands before the first start resolves; it must not send its own start.
    if (get().phase !== "idle") return;
    set({ phase: "starting", error: null });
    try {
      const result = await systemClient.startRendererCpuProfile();
      if (result.status === "failed") {
        set({
          phase: "idle",
          error:
            result.reason === "already-recording"
              ? "A recording is already in progress. Wait for it to finish and try again."
              : (result.message ?? "Couldn't start the profiler"),
        });
        return;
      }
      set({ phase: "recording", expiresAt: result.expiresAt });
    } catch (err) {
      set({ phase: "idle", error: formatErrorMessage(err, "Couldn't start the profiler") });
    }
  },

  collect: async () => {
    if (get().phase !== "recording") return;
    set({ phase: "saving" });
    let error: string | null = null;
    try {
      const result = await systemClient.stopRendererCpuProfile();
      if (
        result.status === "failed" &&
        result.reason !== "not-recording" &&
        result.reason !== "already-stopping"
      ) {
        error =
          result.reason === "devtools-detached"
            ? "Recording stopped because DevTools attached to this window. Close DevTools and try again."
            : (result.message ??
              (result.reason === "capture-failed"
                ? "Couldn't capture the profile"
                : "Couldn't save the profile"));
      }
    } catch (err) {
      error = formatErrorMessage(err, "Couldn't capture the profile");
    }
    set({ phase: "idle", expiresAt: 0, error });
  },
}));
