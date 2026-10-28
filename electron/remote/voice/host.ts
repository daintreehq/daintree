import type { LinkSession } from "../link/session.js";
import type {
  PaneCorrectionContext,
  PaneProjectInfo,
  PaneScope,
  PaneStartContext,
} from "../../services/voice/paneContext.js";
import {
  fitPaneCorrection,
  fitPaneStart,
  VoicePaneFilesPayloadSchema,
  VoicePaneLinkMethod,
  VoicePaneProjectPayloadSchema,
  VoicePaneReadPayloadSchema,
} from "./linkMethods.js";

export interface VoicePaneSessionSource {
  readonly sessions: ReadonlyArray<{ session: LinkSession }>;
  onSession(listener: (ctx: { session: LinkSession }) => void): () => void;
}

export interface VoicePaneHostDeps {
  readStart(scope: PaneScope, budgetMs: number): Promise<PaneStartContext>;
  readCorrection(scope: PaneScope, budgetMs: number): Promise<PaneCorrectionContext>;
  findFileCandidates(
    scope: PaneScope,
    descriptions: readonly string[],
    budgetMs: number
  ): Promise<string[][]>;
  readProject(projectId: string): PaneProjectInfo;
}

/**
 * Host side of a Shell dictating into one of this host's panes: the pane's
 * context is read and screened here, as a local pane's is, within the budget
 * the Shell will wait, and only from the project the Shell's view shows.
 */
export function installVoicePaneHostWith(
  server: VoicePaneSessionSource,
  deps: VoicePaneHostDeps
): () => void {
  const wired = new WeakSet<LinkSession>();
  const unregisters = new Set<() => void>();
  let disposed = false;

  const wire = ({ session }: { session: LinkSession }): void => {
    if (disposed || wired.has(session)) return;
    wired.add(session);
    const offs = [
      session.registerCallHandler(
        VoicePaneLinkMethod.START,
        VoicePaneReadPayloadSchema,
        async ({ budgetMs, ...scope }) => fitPaneStart(await deps.readStart(scope, budgetMs))
      ),
      session.registerCallHandler(
        VoicePaneLinkMethod.CORRECTION,
        VoicePaneReadPayloadSchema,
        async ({ budgetMs, ...scope }) =>
          fitPaneCorrection(await deps.readCorrection(scope, budgetMs))
      ),
      session.registerCallHandler(
        VoicePaneLinkMethod.FILES,
        VoicePaneFilesPayloadSchema,
        async ({ budgetMs, descriptions, ...scope }) => ({
          candidates: await deps.findFileCandidates(scope, descriptions, budgetMs),
        })
      ),
      session.registerCallHandler(
        VoicePaneLinkMethod.PROJECT,
        VoicePaneProjectPayloadSchema,
        ({ projectId }) => ({ project: deps.readProject(projectId) })
      ),
    ];
    const unregister = () => {
      for (const off of offs) off();
    };
    unregisters.add(unregister);
    session.onClose(() => {
      unregisters.delete(unregister);
      unregister();
    });
  };

  for (const ctx of server.sessions) wire(ctx);
  const offSession = server.onSession(wire);
  return () => {
    disposed = true;
    offSession();
    for (const unregister of unregisters) unregister();
    unregisters.clear();
  };
}
