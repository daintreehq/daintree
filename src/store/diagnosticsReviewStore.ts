import { create } from "zustand";
import type { DiagnosticsReviewPayload } from "@shared/types/ipc/system";
import type { ReplacementRule } from "@shared/utils/diagnosticsTransform";
import { systemClient } from "@/clients";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  buildDiagnosticsIssueUrl,
  type DiagnosticsIssueMetadata,
} from "@shared/utils/githubIssueUrl";
import { notify } from "@/lib/notify";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

export interface DiagnosticsReviewScope {
  /** Time window hint (ms) — currently UI metadata; no backend filtering yet. */
  timeWindowMs?: number;
  /** Surface that requested the export, for correlation in future telemetry. */
  source?: string;
  /** Pre-selected section keys. Sections not listed start unchecked. */
  sections?: string[];
}

/**
 * How a completed save is confirmed. `toast` closes the review and raises a
 * notification; `inline` keeps the review open on its saved view, for a surface
 * where no Toaster is mounted yet (the crash-recovery screen).
 */
export type DiagnosticsSaveConfirmation = "toast" | "inline";

interface DiagnosticsReviewState {
  isOpen: boolean;
  isCollecting: boolean;
  isSaving: boolean;
  reviewPayload: DiagnosticsReviewPayload | null;
  scope: DiagnosticsReviewScope | null;
  downloadError: string | null;
  /**
   * A failed save, shown inside the review dialog that attempted it. Kept apart
   * from `downloadError`, which the surfaces behind the dialog render and which
   * a modal hides.
   */
  saveError: string | null;
  /**
   * Set when a save confirmed inline has written the bundle: the review dialog
   * swaps to its saved view, which links here. Only a save the user completed
   * sets it; a cancelled or failed one never does. Cleared by the next open.
   */
  savedIssueUrl: string | null;
  /**
   * Monotonic counter bumped each time the review opens. Used as the
   * always-mounted host's ErrorBoundary `resetKeys` signal so a crashed host
   * auto-recovers on the next open — including a re-open while `isOpen` is
   * already true, which a `Number(isOpen)` key would miss (#9918).
   */
  requestSeq: number;

  openReview: (scope?: DiagnosticsReviewScope) => Promise<void>;
  closeReview: () => void;
  saveReview: (
    enabledSections: Record<string, boolean>,
    replacements: ReplacementRule[],
    timeWindowStartMs?: number | null,
    confirmation?: DiagnosticsSaveConfirmation
  ) => Promise<void>;
  /** Opens the issue a saved view links to, then closes the review. */
  continueToIssue: () => void;
  clearError: () => void;
}

function openIssue(url: string): void {
  safeFireAndForget(systemClient.openExternal(url), {
    context: "Opening GitHub issue from diagnostics save",
  });
}

/** Pull the GitHub-issue env summary fields out of the untyped review payload. */
function extractIssueMetadata(payload: Record<string, unknown>): DiagnosticsIssueMetadata {
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null;
  const section = (key: string): Record<string, unknown> | undefined => {
    const value = payload[key];
    return isRecord(value) ? value : undefined;
  };
  const metadata = section("metadata");
  const runtime = section("runtime");
  const os = section("os");
  return {
    appVersion: str(metadata?.appVersion),
    electronVersion: str(metadata?.electronVersion),
    nodeVersion: str(metadata?.nodeVersion),
    platform: str(runtime?.platform) ?? str(os?.platform),
    osVersion: str(os?.version) ?? str(os?.release),
  };
}

export const useDiagnosticsReviewStore = create<DiagnosticsReviewState>((set, get) => ({
  isOpen: false,
  isCollecting: false,
  isSaving: false,
  reviewPayload: null,
  scope: null,
  downloadError: null,
  saveError: null,
  savedIssueUrl: null,
  requestSeq: 0,

  openReview: async (scope) => {
    // Block while a prior open is in flight OR while a save is still resolving
    // — otherwise a second open swaps `reviewPayload` underneath the in-flight
    // save and the save's success callback would then close the freshly opened
    // dialog.
    if (get().isCollecting || get().isSaving) return;
    set({ isCollecting: true, downloadError: null });
    try {
      const payload = await systemClient.collectDiagnosticsForReview();
      set((state) => ({
        isOpen: true,
        reviewPayload: payload,
        scope: scope ?? null,
        isCollecting: false,
        saveError: null,
        savedIssueUrl: null,
        requestSeq: state.requestSeq + 1,
      }));
    } catch (err) {
      set({
        isCollecting: false,
        downloadError: formatErrorMessage(err, "Failed to collect diagnostics"),
      });
    }
  },

  closeReview: () => {
    // A failed save's error and the saved view stay until the next open: the
    // dialog is still fading out on them, and swapping its content mid-exit
    // would flash the review form back up.
    set({ isOpen: false, scope: null });
  },

  saveReview: async (enabledSections, replacements, timeWindowStartMs, confirmation = "toast") => {
    const { reviewPayload, isOpen, isSaving, isCollecting, savedIssueUrl } = get();
    // Only the open review form saves: not a closed dialog, not one whose
    // payload a new collection is about to replace, not the saved view.
    if (!reviewPayload || !isOpen || isSaving || isCollecting || savedIssueUrl) return;
    set({ isSaving: true, saveError: null });
    const payload = reviewPayload.payload;
    let saved: boolean;
    try {
      saved = await systemClient.saveDiagnosticsBundle({
        payload,
        enabledSections,
        replacements,
        timeWindowStartMs,
        collectedAtMs: reviewPayload.collectedAtMs,
      });
    } catch (err) {
      set({
        isSaving: false,
        saveError: formatErrorMessage(err, "Failed to save diagnostics bundle"),
      });
      return;
    }
    // The user dismissed the native save dialog: nothing was written, so the
    // review stays as it was.
    if (!saved) {
      set({ isSaving: false });
      return;
    }
    const issueUrl = buildDiagnosticsIssueUrl(extractIssueMetadata(payload));
    if (confirmation === "inline") {
      set({ isSaving: false, savedIssueUrl: issueUrl, downloadError: null });
      return;
    }
    set({ isSaving: false, isOpen: false, scope: null, downloadError: null });
    notify({
      type: "success",
      title: "Diagnostics saved",
      message: "Open a GitHub issue and drag the saved ZIP into it.",
      // The saved ZIP is already revealed in the OS file manager, so this
      // is a one-shot action prompt — no durable inbox row needed.
      transient: true,
      priority: "high",
      context: { eventKind: "settings" },
      action: {
        label: "Continue to GitHub issue",
        variant: "primary",
        onClick: () => openIssue(issueUrl),
      },
    });
  },

  continueToIssue: () => {
    const { savedIssueUrl, isOpen } = get();
    if (!savedIssueUrl || !isOpen) return;
    openIssue(savedIssueUrl);
    set({ isOpen: false, scope: null });
  },

  clearError: () => set({ downloadError: null }),
}));
