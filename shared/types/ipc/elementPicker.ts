/**
 * Wire types for the core Element Picker: the dev preview panel's own picker,
 * reached without any plugin.
 *
 * Two machines answer it when a window is attached to a remote host. Binding
 * the preview's page, and everything the page says, belongs to the machine
 * showing the preview (`bind`, `reselect`, the `event` push); reading the
 * project's source belongs to the machine holding the worktree (the
 * workspace, `resolve`, `describeProject`, `sourceRevisions` and the
 * `source-changed` push). Lifecycle calls on a binding (detach, mode, clearing
 * the selection or the hover) are the site-preview bridge's, which serves core
 * and plugin bindings alike.
 *
 * Structural only, and free of any `electron/` import: the schemas that
 * validate what crosses live with the handlers.
 */

import type { FrameworkDetection } from "../../elementPicker/observation.js";
import type { ElementPickerEvent } from "../../elementPicker/protocol.js";
import type { ProjectContextOutcome } from "../../elementPicker/projectContext.js";
import type { FileRevision, SourceFileRef } from "../../elementPicker/resolution.js";
import type { ResolveRequest, ResolveResponse } from "../../elementPicker/resolver.js";
import type { ElementPickerProviderId } from "../../elementPicker/source.js";
import type {
  SitePreviewBindingState,
  SitePreviewMode,
  SitePreviewPushPayload,
} from "./sitePreview.js";

/* -------------------------------------------------------------------------- */
/* The preview (the machine showing it)                                       */
/* -------------------------------------------------------------------------- */

export interface ElementPickerBindRequest {
  /** The dev preview panel whose page the picker binds. */
  panelId: string;
  mode?: SitePreviewMode;
}

export type ElementPickerBindingState = SitePreviewBindingState;

export interface ElementPickerSourcePoint {
  file: string;
  line: number;
  column: number;
}

/**
 * How a framework's reader finds an element again after the page replaced it.
 * Built from what the page itself reported about the element; the page's
 * reader validates it again before it acts on any of it.
 */
export interface ElementPickerLocator {
  /** Where the page said the element is written, in its own spelling. */
  loc: ElementPickerSourcePoint;
  /** Which of the elements written there, in document order. */
  index: number;
  /** The component call site the selection was widened to, kept through the reselect. */
  component?: ElementPickerSourcePoint;
}

export interface ElementPickerReselectRequest {
  sessionId: string;
  /** The id the page reported the element under; it names that element only while it is still the same node. */
  elementId?: string;
  framework?: ElementPickerProviderId;
  locator?: ElementPickerLocator;
  /** Scroll the element into view, as picking it from the trail does; never for a reselect after an edit. */
  reveal?: boolean;
}

/**
 * What a core binding pushes to the view that made it: the bridge's lifecycle
 * events, the page's admitted events, and what the host did about them.
 */
export type ElementPickerPushPayload =
  | SitePreviewPushPayload
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
      framework: ElementPickerProviderId;
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

/* -------------------------------------------------------------------------- */
/* The source (the machine holding the worktree)                              */
/* -------------------------------------------------------------------------- */

/**
 * Opens the source workspace a preview's selections resolve against. The
 * project is the sender's and the worktree's path is main's own reading of
 * that project; nothing here names a path main has not already authorised.
 */
export interface ElementPickerWorkspaceOpenRequest {
  /** The dev preview the workspace serves; source changes are pushed about it. */
  panelId: string;
  worktreeId: string;
  /**
   * Where the preview's dev server runs, as the panel records it. It chooses
   * among the apps inside the worktree, and authorises nothing.
   */
  serverCwd?: string;
  /** An app the user picked: worktree-relative POSIX, `.` for the worktree itself. */
  appPath?: string;
  /**
   * The page's origin, which source maps are fetched from and nowhere else. A
   * loopback HTTP(S) origin; anything else opens a workspace that fetches none.
   */
  previewOrigin?: string;
}

export type ElementPickerWorkspaceOpenResult =
  | {
      status: "ready";
      workspaceId: string;
      /** The app reads are contained to, worktree-relative; `.` for the worktree itself. */
      appPath: string;
      /** Every app the worktree was found to hold, when there is more than one to switch between. */
      appPaths: string[];
      /** False when the search for apps stopped at its bound, so `appPaths` may be short. */
      scanComplete: boolean;
    }
  /** More than one app, and nothing says which one the preview serves: the user chooses. */
  | { status: "ambiguous"; appPaths: string[]; scanComplete: boolean }
  /** The worktree is not one of the sender's project's, or the chosen app is not inside it. */
  | { status: "unavailable"; reason: "unknown-worktree" | "invalid-app" };

export interface ElementPickerWorkspaceRequest {
  workspaceId: string;
}

export interface ElementPickerDescribeProjectRequest {
  workspaceId: string;
  /** The page's address; matched against the app's routes the way its router would. */
  url: string;
}

export interface ElementPickerSourceRevisionsRequest {
  workspaceId: string;
  /** `SourceFileRef` paths in that workspace. */
  paths: string[];
}

export interface ElementPickerSourceRevisionsResult {
  /** In request order; null for a file that is gone, unreadable, outside the app or past the size cap. */
  revisions: Array<{ path: string; revision: FileRevision | null }>;
}

/** A file a resolve read changed on disk: typically an agent editing what the user selected. */
export interface ElementPickerSourceChangedPush {
  workspaceId: string;
  panelId: string;
  file: SourceFileRef;
  /** Null once the file is no longer readable source. */
  revision: FileRevision | null;
}

export type ElementPickerResolveRequest = ResolveRequest;
export type ElementPickerResolveResponse = ResolveResponse;
export type ElementPickerProjectOutcome = ProjectContextOutcome;

/**
 * The message a workspace call fails with when the workspace is not open to
 * the caller: closed, never opened, or another view's. Carried as an
 * `[AppError|NOT_FOUND]`, so the view can reopen rather than retry.
 */
export const ELEMENT_PICKER_WORKSPACE_CLOSED = "The Element Picker workspace is not open";
