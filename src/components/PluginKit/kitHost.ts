import type { ComponentType } from "react";
import type {
  ActionDanger,
  ActionDispatchOptions,
  ActionDispatchResult,
  ActionId,
} from "@shared/types/actions";
import type { DiffViewerProps } from "@/components/Worktree/DiffViewer";
import type { PluginArtifact, PluginArtifactSource } from "@shared/types/pluginArtifacts";

// What the kit needs from the app it renders in: dispatching actions, toasts,
// a plugin's own worker, and the diff viewer. The kit reads them here instead
// of importing ActionService, `notify` or DiffViewer, so it bundles on its own
// for a plain page (the plugin preview); the app installs its own at boot
// (`services/plugin/appPluginKitHost.ts`), and a preview may install others.
// Without a host every capability is inert and the kit still renders.

export interface PluginKitToast {
  type: "info" | "success" | "warning" | "error";
  message: string;
  duration?: number;
  rateLimitKey?: string;
  rateLimitLabel?: string;
  transient?: boolean;
  action?: { label: string; onClick: () => void };
}

/** What the kit reads of an action before offering it to a plugin view. */
export interface PluginKitActionInfo {
  title: string;
  danger: ActionDanger;
  enabled: boolean;
  disabledReason?: string;
}

/** The diff viewer props the kit DiffView sets. */
export type PluginKitDiffViewerProps = Pick<
  DiffViewerProps,
  "diff" | "viewType" | "wrapLines" | "source" | "language" | "renderHunkActions" | "openInEditor"
>;

export interface PluginKitHost {
  dispatchAction(
    actionId: ActionId,
    args: unknown,
    options: ActionDispatchOptions
  ): Promise<ActionDispatchResult>;
  /** Null when the host has no action by that id. */
  getAction(actionId: ActionId): PluginKitActionInfo | null;
  deniesPluginDispatch(actionId: ActionId): boolean;
  selfNotifiesOnExecutionError(actionId: ActionId): boolean;
  /** Shows a toast; its id, or null when nothing was shown. */
  showToast(toast: PluginKitToast): string | null;
  dismissToast(id: string): void;
  /** The plugin's name as a person reads it, when the host knows it. */
  pluginDisplayName(owner: string): string | undefined;
  /** Calls a handler the plugin's worker registered. */
  invokePlugin(owner: string, channel: string, payload: unknown): Promise<unknown>;
  /** Draws a DiffView's patch; null leaves the kit's plain-text fallback. */
  DiffViewer: ComponentType<PluginKitDiffViewerProps> | null;
  /** Imports Files the person dropped or picked as the owner plugin's artifacts (#14100). */
  importArtifacts(owner: string, files: readonly File[]): Promise<PluginArtifact[]>;
  /** A source for one of the owner's artifacts, leased to this view. */
  artifactSource(owner: string, artifactId: string): Promise<PluginArtifactSource>;
  /** Ends the lease behind a source URL `artifactSource` gave. */
  releaseArtifactSource(url: string): void;
  /**
   * Calls `onChange(true)` while media in this view should hold still — the
   * document hidden, the view cached, or its project out of the foreground —
   * and `onChange(false)` when it may play again. Calls once with the current
   * answer. Returns the unsubscribe.
   */
  watchPlaybackHold(onChange: (held: boolean) => void): () => void;
}

/** The hold an app without view lifecycle signals can see: the document hidden. */
export function watchDocumentHidden(onChange: (held: boolean) => void): () => void {
  if (typeof document === "undefined") {
    onChange(false);
    return () => {};
  }
  const report = () => onChange(document.hidden);
  document.addEventListener("visibilitychange", report);
  report();
  return () => document.removeEventListener("visibilitychange", report);
}

const NO_HOST = "Not available outside Daintree";

const inertHost: PluginKitHost = {
  dispatchAction: async () => ({ ok: false, error: { code: "NOT_FOUND", message: NO_HOST } }),
  getAction: () => null,
  deniesPluginDispatch: () => false,
  selfNotifiesOnExecutionError: () => false,
  showToast: () => null,
  dismissToast: () => {},
  pluginDisplayName: () => undefined,
  invokePlugin: async () => {
    throw new Error(NO_HOST);
  },
  DiffViewer: null,
  importArtifacts: async () => {
    throw new Error(NO_HOST);
  },
  artifactSource: async () => {
    throw new Error(NO_HOST);
  },
  releaseArtifactSource: () => {},
  watchPlaybackHold: watchDocumentHidden,
};

let host: PluginKitHost = inertHost;

/**
 * Installs a host; capabilities left out (or undefined) stay inert rather than carrying over
 * from an earlier one. Install before any kit view mounts: mounted views do
 * not re-render for a new host. The returned disposer clears this host only,
 * so a stale cleanup cannot remove a newer one.
 */
export function setPluginKitHost(capabilities: Partial<PluginKitHost>): () => void {
  const given = Object.entries(capabilities).filter(([, value]) => value !== undefined);
  const installed: PluginKitHost = { ...inertHost, ...Object.fromEntries(given) };
  host = installed;
  return () => {
    if (host === installed) host = inertHost;
  };
}

export function getPluginKitHost(): PluginKitHost {
  return host;
}
