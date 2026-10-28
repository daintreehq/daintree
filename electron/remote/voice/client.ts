import type { z } from "zod";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { sanitizeDictionary } from "../../../shared/utils/voiceDictionary.js";
import type {
  HostPaneContextReader,
  HostPaneReadOptions,
} from "../../services/voice/hostPaneContext.js";
import type {
  PaneCorrectionContext,
  PaneProjectInfo,
  PaneScope,
  PaneStartContext,
} from "../../services/voice/paneContext.js";
import { logDebug } from "../../utils/logger.js";
import {
  MAX_PANE_FILE_DESCRIPTIONS,
  MAX_PANE_READ_BUDGET_MS,
  VoicePaneCorrectionResultSchema,
  VoicePaneFilesResultSchema,
  VoicePaneLinkMethod,
  VoicePaneProjectResultSchema,
  VoicePaneStartResultSchema,
} from "./linkMethods.js";

const P = "[VoicePaneHosts]";

/**
 * What the host's answer may take of the Shell's wait, so it is sent before
 * the Shell stops listening. A host further away than this still reads in
 * time when its reads are quick; one that answers late gives no context.
 */
export const LINK_HEADROOM_MS = 100;

export interface VoicePaneHostSession {
  readonly isOpen: boolean;
  call(
    method: string,
    payload: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<unknown>;
}

export interface VoicePaneHostsClientDeps {
  /** The host's current session, or null while it has none. Never dials. */
  sessionFor(hostId: HostId): VoicePaneHostSession | null;
}

function budgetFor(timeoutMs: number): number {
  return Math.min(MAX_PANE_READ_BUDGET_MS, Math.max(1, Math.floor(timeoutMs - LINK_HEADROOM_MS)));
}

/**
 * The Shell's reads of a host's pane. A host with no session, one too old to
 * know the methods, one that answers late and one whose answer doesn't fit
 * the schema all read as no context; nothing here dials or retries.
 */
export class VoicePaneHostsClient implements HostPaneContextReader {
  constructor(private readonly deps: VoicePaneHostsClientDeps) {}

  private async call<S extends z.ZodType>(
    hostId: HostId,
    method: string,
    payload: Record<string, unknown>,
    schema: S,
    { timeoutMs, signal }: HostPaneReadOptions
  ): Promise<z.infer<S> | null> {
    const session = this.deps.sessionFor(hostId);
    if (!session?.isOpen || signal?.aborted) return null;
    try {
      const raw = await session.call(
        method,
        { ...payload, budgetMs: budgetFor(timeoutMs) },
        { timeoutMs, signal }
      );
      const parsed = schema.safeParse(raw);
      if (parsed.success) return parsed.data;
      logDebug(`${P} Host answered out of shape`, { method });
      return null;
    } catch (error) {
      // Codes only: what a host says can quote paths and names.
      const code = (error as { code?: unknown } | null)?.code;
      logDebug(`${P} Host read failed`, { method, code: typeof code === "string" ? code : null });
      return null;
    }
  }

  async readStart(
    hostId: HostId,
    scope: PaneScope,
    options: HostPaneReadOptions
  ): Promise<PaneStartContext | null> {
    const result = await this.call(
      hostId,
      VoicePaneLinkMethod.START,
      { ...scope },
      VoicePaneStartResultSchema,
      options
    );
    if (!result) return null;
    return { ...result, vocabulary: sanitizeDictionary(result.vocabulary, Date.now()) };
  }

  async readCorrection(
    hostId: HostId,
    scope: PaneScope,
    options: HostPaneReadOptions
  ): Promise<PaneCorrectionContext | null> {
    const result = await this.call(
      hostId,
      VoicePaneLinkMethod.CORRECTION,
      { ...scope },
      VoicePaneCorrectionResultSchema,
      options
    );
    if (!result) return null;
    return { ...result, vocabulary: sanitizeDictionary(result.vocabulary, Date.now()) };
  }

  async findFileCandidates(
    hostId: HostId,
    scope: PaneScope,
    descriptions: readonly string[],
    options: HostPaneReadOptions
  ): Promise<string[][] | null> {
    const asked = descriptions.slice(0, MAX_PANE_FILE_DESCRIPTIONS);
    const result = await this.call(
      hostId,
      VoicePaneLinkMethod.FILES,
      { ...scope, descriptions: asked },
      VoicePaneFilesResultSchema,
      options
    );
    // One list per description asked, or none of them can be trusted to line up.
    if (!result || result.candidates.length !== asked.length) return null;
    return result.candidates;
  }

  async readProject(
    hostId: HostId,
    projectId: string,
    options: HostPaneReadOptions
  ): Promise<PaneProjectInfo | null> {
    const result = await this.call(
      hostId,
      VoicePaneLinkMethod.PROJECT,
      { projectId },
      VoicePaneProjectResultSchema,
      options
    );
    return result?.project ?? null;
  }
}
