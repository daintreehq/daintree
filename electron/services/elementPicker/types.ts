import type { SitePreviewPushPayload } from "../../../shared/types/ipc/sitePreview.js";
import type { FrameworkDetection } from "../../../shared/elementPicker/observation.js";
import type { ElementPickerEvent } from "../../../shared/elementPicker/protocol.js";
import type { ElementPickerFramework } from "../../../shared/elementPicker/source.js";

/**
 * Where a core picker binding's traffic goes: the bridge's lifecycle events,
 * the page's admitted events, and what the host itself did about them. Main
 * process only for now — the dev preview panel subscribes in #13872 — and
 * never the plugin push channel, whose consumers expect the plugin protocol.
 */
export type ElementPickerPushPayload =
  | Exclude<SitePreviewPushPayload, { kind: "guest-event" }>
  | {
      kind: "picker-event";
      sessionId: string;
      panelId: string;
      projectId: string;
      documentEpoch: number;
      sequence: number;
      event: ElementPickerEvent;
    }
  /** What the host's main-world probe saw, validated; the host decides installs from it. */
  | {
      kind: "frameworks-probed";
      sessionId: string;
      projectId: string;
      documentEpoch: number;
      detections: FrameworkDetection[];
    }
  | {
      kind: "extractor-installed";
      sessionId: string;
      projectId: string;
      documentEpoch: number;
      framework: ElementPickerFramework;
    }
  /**
   * A problem the host observed, in the guest's own issue shape. Separate from
   * `picker-event` because it carries no guest sequence: the host neither
   * invents one nor spends one of the page's.
   */
  | {
      kind: "host-issue";
      sessionId: string;
      projectId: string;
      documentEpoch: number;
      issue: Extract<ElementPickerEvent, { type: "runtimeIssue" }>;
    };

export type ElementPickerSink = (payload: ElementPickerPushPayload) => void;
