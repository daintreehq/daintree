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

interface DiagnosticsReviewState {
  isOpen: boolean;
  isCollecting: boolean;
  isSaving: boolean;
  reviewPayload: DiagnosticsReviewPayload | null;
  scope: DiagnosticsReviewScope | null;
  downloadError: string | null;

  openReview: (scope?: DiagnosticsReviewScope) => Promise<void>;
  closeReview: () => void;
  saveReview: (
    enabledSections: Record<string, boolean>,
    replacements: ReplacementRule[],
    timeWindowStartMs?: number | null
  ) => Promise<void>;
  clearError: () => void;
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

  openReview: async (scope) => {
    // Block while a prior open is in flight OR while a save is still resolving
    // — otherwise a second open swaps `reviewPayload` underneath the in-flight
    // save and the save's success callback would then close the freshly opened
    // dialog.
    if (get().isCollecting || get().isSaving) return;
    set({ isCollecting: true, downloadError: null });
    try {
      const payload = await systemClient.collectDiagnosticsForReview();
      set({
        isOpen: true,
        reviewPayload: payload,
        scope: scope ?? null,
        isCollecting: false,
      });
    } catch (err) {
      set({
        isCollecting: false,
        downloadError: formatErrorMessage(err, "Failed to collect diagnostics"),
      });
    }
  },

  closeReview: () => {
    set({ isOpen: false, scope: null });
  },

  saveReview: async (enabledSections, replacements, timeWindowStartMs) => {
    const { reviewPayload } = get();
    if (!reviewPayload || get().isSaving) return;
    set({ isSaving: true });
    try {
      const payload = reviewPayload.payload;
      const saved = await systemClient.saveDiagnosticsBundle({
        payload,
        enabledSections,
        replacements,
        timeWindowStartMs,
      });
      if (saved) {
        const issueUrl = buildDiagnosticsIssueUrl(extractIssueMetadata(payload));
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
            onClick: () => {
              safeFireAndForget(systemClient.openExternal(issueUrl), {
                context: "Opening GitHub issue from diagnostics save",
              });
            },
          },
        });
        set({ isSaving: false, isOpen: false, scope: null, downloadError: null });
      } else {
        set({ isSaving: false });
      }
    } catch (err) {
      set({
        isSaving: false,
        downloadError: formatErrorMessage(err, "Failed to save diagnostics bundle"),
      });
    }
  },

  clearError: () => set({ downloadError: null }),
}));
