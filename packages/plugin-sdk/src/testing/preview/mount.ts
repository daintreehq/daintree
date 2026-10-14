import { Fragment, StrictMode, createElement, useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { formatErrorMessage } from "../../../../../shared/utils/errorMessage.js";
import { resetHostChannelCache } from "../../react/useCachedHostChannel.js";
import { createMockViewHost, type MockViewHost } from "./mockViewHost.js";
import { createPreviewPanelController, type PreviewPanelController } from "./panelProps.js";
import {
  composePanelStory,
  type ComposedPanelStory,
  type PanelStoriesMeta,
  type PanelStory,
} from "./stories.js";
import { DEFAULT_PREVIEW_THEME_ID, applyPreviewTheme, type PreviewTheme } from "./themes.js";

/** Attribute the page's readiness is published on: `ready` or `failed`, absent while pending. */
export const PREVIEW_READY_ATTRIBUTE = "data-daintree-preview-ready";
/** Why the preview failed, beside {@link PREVIEW_READY_ATTRIBUTE}`="failed"`. */
export const PREVIEW_FAILURE_ATTRIBUTE = "data-daintree-preview-failure";

/**
 * Where the preview's Tailwind CSS comes from.
 *
 * Daintree compiles a plugin's classes at runtime, scoped to the view's style
 * root, so a preview styled the way the host styles it plugs the host's own
 * style runtime in here (Daintree's repo does, in its plugin panel preview
 * page). Without one the view renders with whatever stylesheets the page
 * loads, and readiness has no styles to wait for.
 */
export interface PreviewStyleHost {
  /** Bring the view's style root into the styling contract. Returns the release. */
  registerRoot(root: Element): () => void;
  /** Resolves once CSS for what is in the DOM now has been installed, or failed to. */
  settled?(): Promise<void>;
  /** Why styles failed to install, or `null` while nothing has failed. */
  failure(): string | null;
  /**
   * Hear about a failure that happens after the page reported ready — a class
   * that appeared later and did not compile. Returns the unsubscribe.
   */
  subscribe?(onFailure: () => void): () => void;
}

/** Something the page waits on before it is ready — the UI kit, for one. */
export interface PreviewReadinessGate {
  readonly ready: PromiseLike<unknown>;
}

export type PreviewReadiness = { status: "ready" } | { status: "failed"; reason: string };

export interface MountPanelPreviewOptions {
  /** The element the preview renders into. Its children are replaced. */
  container: HTMLElement;
  /** Built-in theme id. Defaults to `daintree`. */
  theme?: string;
  /** Where theme variables go. Defaults to the container's document root. */
  themeRoot?: HTMLElement;
  styles?: PreviewStyleHost;
  /** Gate readiness on the UI kit, for a panel that uses it. */
  kit?: PreviewReadinessGate;
  /** Render under `StrictMode`, as Daintree's dev builds do. Default `true`. */
  strictMode?: boolean;
}

/**
 * A mounted preview. One per document: the mock bridges live on
 * `globalThis.electron`, which only one session can own at a time.
 */
export interface MountedPanelPreview {
  readonly host: MockViewHost;
  readonly panel: PreviewPanelController;
  readonly theme: PreviewTheme;
  /** The marked style root the view renders into. */
  readonly canvasElement: HTMLElement;
  /**
   * Settles once the story has mounted, `play` has run, and fonts, kit and
   * styles are in — or with the first of them that failed. Start the mount,
   * let React commit, then await this; under `act()`, not inside the same
   * `act()` callback that mounted.
   */
  readonly ready: Promise<PreviewReadiness>;
  /** Switch theme in place, keeping the view and its state. Readiness re-arms. */
  setTheme(themeId: string): Promise<PreviewReadiness>;
  /**
   * Mount a fresh attempt of the same panel, as a sibling maximize or a
   * project switch does: it reads back what the last one persisted.
   */
  remount(): Promise<PreviewReadiness>;
  /** Unmount, release the style root, and take the mock bridges off the page. */
  unmount(): void;
}

function errorText(error: unknown): string {
  return formatErrorMessage(error, String(error));
}

function MountProbe({ onMounted }: { onMounted: () => void }) {
  // Siblings commit before this effect runs, so it fires once the view is in
  // the DOM. StrictMode fires it twice; the callback is idempotent.
  useEffect(() => {
    onMounted();
  }, [onMounted]);
  return null;
}

interface PendingMount {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function pendingMount(): PendingMount {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Mount a composed story against a fresh mock view host. Lower level than
 * {@link mountPanelStory}, for a caller that has already merged meta and story.
 */
export function mountComposedPanelStory(
  composed: ComposedPanelStory,
  options: MountPanelPreviewOptions
): MountedPanelPreview {
  const { container } = options;
  const doc = container.ownerDocument;
  const themeRoot = options.themeRoot ?? doc.documentElement;
  const publishTargets = themeRoot === container ? [container] : [container, doc.documentElement];

  // Validated before anything global is touched: an unknown theme throws here
  // and leaves the page as it was.
  let theme = applyPreviewTheme(themeRoot, options.theme ?? DEFAULT_PREVIEW_THEME_ID);

  let disposed = false;
  /** The attempt a reload is queued for, if one is. */
  let reloadQueuedFor: number | null = null;
  const panel = createPreviewPanelController(composed.args, {
    // Calls in one tick coalesce into one reload, as the host's do. Only a
    // live attempt can ask, and the reload is for that attempt: one replaced
    // in the meantime has nothing left to reload.
    onReloadRequested: () => {
      if (reloadQueuedFor === attemptKey) return;
      const requestedBy = attemptKey;
      reloadQueuedFor = requestedBy;
      queueMicrotask(() => {
        if (reloadQueuedFor === requestedBy) reloadQueuedFor = null;
        if (disposed || attemptKey !== requestedBy) return;
        void replaceAttempt(true);
      });
    },
  });
  const host = createMockViewHost({
    pluginId: panel.pluginId,
    channels: composed.fixtures.channels,
    viewCached: composed.fixtures.viewCached,
  });

  const cleanups: Array<() => void> = [];
  const runCleanups = () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch {
        // Keep unwinding: one failed release must not leave the bridges installed.
      }
    }
  };

  const canvasElement = doc.createElement("div");
  let root!: Root;
  let generation = 0;
  let published: PreviewReadiness | null = null;
  /** The current attempt's pending mount, until its probe fires. */
  let pending: PendingMount | null = null;
  /** Why the mounted view stopped rendering, after it had mounted. */
  let crashed: string | null = null;
  /** Mount (and, the first time, `play`) for the current attempt. */
  let content: Promise<string | null> = Promise.resolve(null);
  let attemptKey = 0;

  function publish(readiness: PreviewReadiness | null): void {
    published = readiness;
    for (const target of publishTargets) {
      if (readiness === null) {
        target.removeAttribute(PREVIEW_READY_ATTRIBUTE);
        target.removeAttribute(PREVIEW_FAILURE_ATTRIBUTE);
        continue;
      }
      target.setAttribute(PREVIEW_READY_ATTRIBUTE, readiness.status);
      if (readiness.status === "failed") {
        target.setAttribute(PREVIEW_FAILURE_ATTRIBUTE, readiness.reason);
      } else {
        target.removeAttribute(PREVIEW_FAILURE_ATTRIBUTE);
      }
    }
  }

  const styleFailure = (): string | null => {
    const failure = options.styles?.failure() ?? null;
    return failure === null ? null : `styles failed to install: ${failure}`;
  };

  /** Take a ready page back: what it shows is no longer complete. */
  function revoke(reason: string): void {
    if (disposed || published?.status !== "ready") return;
    publish({ status: "failed", reason });
  }

  function onUncaughtError(error: unknown): void {
    if (pending) {
      pending.reject(error);
      return;
    }
    // After the mount: React has torn the view down, so its attempt is over.
    crashed = `view stopped rendering: ${errorText(error)}`;
    panel.disposeAttempt();
    revoke(crashed);
  }

  /** Render a fresh attempt. Never throws: a refusal is a failed mount. */
  function render(): Promise<void> {
    attemptKey += 1;
    cancelPending("superseded by a new attempt");
    const mount = pendingMount();
    pending = mount;
    crashed = null;
    let settled = false;
    const onMounted = () => {
      if (settled) return;
      settled = true;
      if (pending === mount) pending = null;
      mount.resolve();
    };
    try {
      const tree = createElement(
        Fragment,
        null,
        // Keyed per attempt, so a remount is a new instance rather than a re-render.
        createElement(composed.component, { ...panel.props(), key: attemptKey }),
        createElement(MountProbe, { onMounted })
      );
      root.render(options.strictMode === false ? tree : createElement(StrictMode, null, tree));
    } catch (error) {
      if (pending === mount) pending = null;
      mount.reject(error);
    }
    return mount.promise;
  }

  async function mountContent(mounted: Promise<void>, runPlay: boolean): Promise<string | null> {
    try {
      await mounted;
    } catch (error) {
      return `story did not mount: ${errorText(error)}`;
    }
    if (runPlay && composed.play) {
      try {
        await composed.play({ host, panel, canvasElement });
      } catch (error) {
        return `play failed: ${errorText(error)}`;
      }
    }
    return null;
  }

  async function settle(contentReady: Promise<string | null>): Promise<PreviewReadiness> {
    const fail = (reason: string): PreviewReadiness => ({ status: "failed", reason });
    const contentFailure = await contentReady;
    if (contentFailure) return fail(contentFailure);
    try {
      await options.kit?.ready;
    } catch (error) {
      return fail(`kit did not load: ${errorText(error)}`);
    }
    try {
      await options.styles?.settled?.();
    } catch (error) {
      return fail(`styles did not settle: ${errorText(error)}`);
    }
    // Last, so a face the kit or the styles brought into use is counted.
    // Feature-detected: jsdom has no `document.fonts`. `ready` fulfils even
    // when a face failed, so failures are read off the faces themselves.
    const fonts = (doc as Partial<Pick<Document, "fonts">>).fonts;
    if (fonts) {
      await fonts.ready;
      const failedFamilies: string[] = [];
      fonts.forEach((face) => {
        if (face.status === "error") failedFamilies.push(face.family);
      });
      if (failedFamilies.length > 0) return fail(`font did not load: ${failedFamilies[0]}`);
    }
    if (crashed) return fail(crashed);
    const failure = styleFailure();
    return failure ? fail(failure) : { status: "ready" };
  }

  /** Re-arm readiness and publish it for the latest generation only. */
  function track(contentReady: Promise<string | null>): Promise<PreviewReadiness> {
    const mine = ++generation;
    publish(null);
    return settle(contentReady).then((readiness) => {
      if (mine === generation && !disposed) publish(readiness);
      return readiness;
    });
  }

  /** Settle a mount that will never commit, so its readiness does not hang. */
  function cancelPending(reason: string): void {
    const cancelled = pending;
    pending = null;
    cancelled?.reject(new Error(reason));
  }

  function replaceAttempt(reload: boolean): Promise<PreviewReadiness> {
    // The outgoing view unmounts first, its cleanups run, and only then is its
    // signal aborted and the record read for the next attempt — the host's
    // order, so state persisted from a cleanup comes back.
    flushSync(() => root.render(null));
    panel.disposeAttempt();
    // After the cleanups, so nothing the outgoing view published on its way
    // out survives a reload.
    if (reload) panel.clearViewState();
    content = mountContent(render(), false);
    return track(content);
  }

  let ready: Promise<PreviewReadiness>;
  try {
    cleanups.push(host.install());
    // The cached-channel cache is module state shared by every view in the
    // document; a previous story's answers must not leak into this one.
    resetHostChannelCache();

    for (const [name, value] of Object.entries(panel.styleRootAttributes)) {
      canvasElement.setAttribute(name, value);
    }
    canvasElement.style.height = "100%";
    container.replaceChildren(canvasElement);
    cleanups.push(() => canvasElement.remove());
    const releaseStyles = options.styles?.registerRoot(canvasElement);
    if (releaseStyles) cleanups.push(releaseStyles);

    // A view that throws while rendering never commits, so its mount would
    // otherwise wait forever. React 19 reports it here instead.
    root = createRoot(canvasElement, { onUncaughtError });
    cleanups.push(() => root.unmount());
    cleanups.push(() => publish(null));

    // A class that shows up after the page said ready, and does not compile,
    // takes the ready state back: a capture taken now would be half-styled.
    const unsubscribeStyles = options.styles?.subscribe?.(() => {
      const failure = styleFailure();
      if (failure) revoke(failure);
    });
    if (unsubscribeStyles) cleanups.push(unsubscribeStyles);

    content = mountContent(render(), true);
    ready = track(content);
  } catch (error) {
    disposed = true;
    runCleanups();
    panel.disposeAttempt();
    throw error;
  }

  return {
    host,
    panel,
    get theme() {
      return theme;
    },
    canvasElement,
    ready,
    setTheme(themeId) {
      theme = applyPreviewTheme(themeRoot, themeId);
      // The attempt's own mount and `play` still gate it: switching theme
      // mid-`play`, or after a failed mount, is not a ready page.
      return track(content);
    },
    remount: () => replaceAttempt(false),
    unmount() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      cancelPending("unmounted");
      runCleanups();
      // After React's cleanups, as the host aborts it.
      panel.disposeAttempt();
    },
  };
}

/** Mount one story of a `panel.stories.tsx` module against a fresh mock view host. */
export function mountPanelStory(
  meta: PanelStoriesMeta,
  story: PanelStory | undefined,
  options: MountPanelPreviewOptions
): MountedPanelPreview {
  return mountComposedPanelStory(composePanelStory(meta, story), options);
}
