import { vi } from "vitest";
import type {
  ElementPickerEvent,
  FileRevision,
  HoverObservation,
  ProjectContextOutcome,
  ResolutionResult,
  ResolveRequest,
  ResolveResponse,
  SelectionObservation,
  SelectionScope,
  SourceCandidate,
} from "@shared/elementPicker";
import {
  ELEMENT_PICKER_WORKSPACE_CLOSED,
  type ElementPickerBindRequest,
  type ElementPickerPushPayload,
  type ElementPickerReselectRequest,
  type ElementPickerSourceChangedPush,
  type ElementPickerSourceRevisionsResult,
  type ElementPickerWorkspaceOpenRequest,
  type ElementPickerWorkspaceOpenResult,
} from "@shared/types/ipc/elementPicker";
import type { SitePreviewBindingState, SitePreviewMode } from "@shared/types/ipc/sitePreview";
import {
  CARD_FILE,
  CARD_REVISION,
  REVISION,
  WORKSPACE,
  reactResults,
  svelteObservation,
  svelteResults,
} from "./fixtures.js";

export const WORKTREE = "/repo";
export const PAGE_URL = "http://localhost:5173/pricing?plan=pro";

/** How the host refuses a call on a workspace it no longer holds for this view, as the preload hands it over. */
export function workspaceClosedError(): Error {
  return new Error(`[AppError|NOT_FOUND] ${ELEMENT_PICKER_WORKSPACE_CLOSED}`);
}

/** The ids of every claim an observation makes: its own and its chain's. */
function candidateIds(observation: SelectionObservation): Set<string> {
  return new Set(
    [
      ...observation.sourceCandidates,
      ...observation.componentChain.components.flatMap((record) => record.sourceCandidates),
    ].map((candidate) => candidate.candidateId)
  );
}

/**
 * Every claim an observation makes, checked where it says, at `revision` — a
 * host that read each file and found what the page reported there. Generated
 * framework files are left unresolved, as the real host leaves them.
 */
export function verifyAll(
  observation: SelectionObservation,
  revision: FileRevision = REVISION
): ResolutionResult[] {
  const candidates: SourceCandidate[] = [
    ...observation.sourceCandidates,
    ...observation.componentChain.components.flatMap((record) => record.sourceCandidates),
  ];
  return candidates.map((candidate): ResolutionResult => {
    if (candidate.file.includes(".svelte-kit/") || candidate.kind === "file-hint") {
      return {
        state: "unavailable",
        candidateId: candidate.candidateId,
        claim: candidate.kind,
        reason: "unsupported",
      };
    }
    return {
      state: "verified",
      candidateId: candidate.candidateId,
      claim: candidate.kind,
      target: {
        file: { workspaceId: WORKSPACE, path: candidate.file },
        location: candidate.location,
      },
      fileRevision: revision,
    } as ResolutionResult;
  });
}

/** The page's account of an element on hover: no context, ever. */
export function asHover(observation: SelectionObservation): HoverObservation {
  const { context: _context, phase: _phase, ...rest } = observation;
  return { ...rest, phase: "hover" };
}

/** Where a locator finds the template's element: the stamp moved to its location, and which copy. */
function atLocator(
  observation: SelectionObservation,
  locator: NonNullable<ElementPickerReselectRequest["locator"]>
): SelectionObservation {
  return {
    ...observation,
    sourceCandidates: observation.sourceCandidates.map((candidate) =>
      candidate.kind === "template-location" && candidate.framework === "svelte"
        ? {
            ...candidate,
            file: locator.loc.file,
            location: {
              lineBase: 1,
              columnBase: 0,
              columnUnit: "utf16",
              line: locator.loc.line,
              column: locator.loc.column,
            },
          }
        : candidate
    ),
    frameworkEvidence: observation.frameworkEvidence.map((entry) =>
      entry.kind === "svelte" ? { ...entry, locIndex: locator.index } : entry
    ),
  };
}

/** The component in an observation's chain invoked at a call site, as the page spells it. */
function componentAt(
  observation: SelectionObservation,
  site: { file: string; line: number; column: number }
): string | null {
  const record = observation.componentChain.components.find((entry) =>
    entry.sourceCandidates.some(
      (candidate) =>
        candidate.kind === "component-invocation" &&
        candidate.file === site.file &&
        candidate.location.line === site.line &&
        candidate.location.column === site.column
    )
  );
  return record?.componentId ?? null;
}

/**
 * Stand-ins for what the picker talks to: the core Element Picker's host
 * (`window.electron.elementPicker`), the site-preview bridge's binding
 * lifecycle (`window.electron.sitePreview`) and the element crop. Pushes are
 * delivered synchronously, exactly as the preload delivers them.
 */
export function createFakeHost() {
  const eventListeners = new Set<(payload: ElementPickerPushPayload) => void>();
  const sourceListeners = new Set<(payload: ElementPickerSourceChangedPush) => void>();
  let sequence = 0;

  const binding = (panelId: string, mode: SitePreviewMode): SitePreviewBindingState => ({
    sessionId: "session-1",
    panelId,
    projectId: "p1",
    documentEpoch: 0,
    mode,
    guestReady: false,
    droppedMessages: 0,
    suspended: false,
  });

  const picker = {
    bind: vi.fn(async (request: ElementPickerBindRequest): Promise<SitePreviewBindingState> =>
      binding(request.panelId, request.mode ?? "select")
    ),
    // As the real page does: find the element (by id while it is still that
    // node, else by Svelte's locator), select it — as a member of the
    // component named by id, or invoked at `locator.component` — and report a
    // fresh observation on the next tick. `reselectFinds` models a page where
    // the element is gone; a component id the chain does not carry, or one it
    // reported no roots for, selects nothing.
    reselect: vi.fn(async (request: ElementPickerReselectRequest): Promise<boolean> => {
      if (!host.reselectFinds) return false;
      const template = host.template();
      const observation = request.locator
        ? atLocator(template, request.locator)
        : { ...template, ...(request.elementId ? { elementId: request.elementId } : {}) };
      const site = request.locator?.component;
      if (
        request.componentId !== undefined &&
        !observation.componentChain.components.some(
          (record) => record.componentId === request.componentId && record.rootElementIds.length > 0
        )
      ) {
        return false;
      }
      const componentId = request.componentId ?? (site ? componentAt(observation, site) : null);
      const scope: SelectionScope =
        componentId === null ? { kind: "element" } : { kind: "component", componentId };
      setTimeout(() => host.select(host.currentEpoch, [observation], "reselect", scope), 0);
      return true;
    }),
    openWorkspace: vi.fn(
      async (
        request: ElementPickerWorkspaceOpenRequest
      ): Promise<ElementPickerWorkspaceOpenResult> => {
        const result = await host.openWith(request);
        if (result.status === "ready") host.workspaceId = result.workspaceId;
        return result;
      }
    ),
    closeWorkspace: vi.fn(async (_request: { workspaceId: string }) => ({ closed: true })),
    resolve: vi.fn((request: ResolveRequest): Promise<ResolveResponse> =>
      host.answerResolve(request)
    ),
    describeProject: vi.fn(
      async (request: { workspaceId: string; url: string }): Promise<ProjectContextOutcome> =>
        host.describeWith(request)
    ),
    sourceRevisions: vi.fn(
      async (request: {
        workspaceId: string;
        paths: string[];
      }): Promise<ElementPickerSourceRevisionsResult> => ({
        revisions: request.paths.map((path) => ({
          path,
          revision: host.diskRevisions.has(path) ? host.diskRevisions.get(path)! : REVISION,
        })),
      })
    ),
    holdSources: vi.fn(async (_request: { workspaceId: string; paths: string[] }) => undefined),
    onEvent: vi.fn((callback: (payload: ElementPickerPushPayload) => void) => {
      eventListeners.add(callback);
      return () => {
        eventListeners.delete(callback);
      };
    }),
    onSourceChanged: vi.fn((callback: (payload: ElementPickerSourceChangedPush) => void) => {
      sourceListeners.add(callback);
      return () => {
        sourceListeners.delete(callback);
      };
    }),
  };

  const preview = {
    detach: vi.fn(async (_request: { sessionId: string }) => undefined),
    setMode: vi.fn(
      async (request: {
        sessionId: string;
        mode: SitePreviewMode;
      }): Promise<SitePreviewBindingState> => binding("preview-1", request.mode)
    ),
    clearSelection: vi.fn(async (_request: { sessionId: string }) => undefined),
    clearHover: vi.fn(async (_request: { sessionId: string }) => undefined),
  };

  /** The host's element crop: a picture saved where agents read pasted images. */
  const captureElement = vi.fn(
    async (
      _panelId: string,
      _request: {
        rect: { x: number; y: number; width: number; height: number };
        viewportWidth: number;
        viewportHeight: number;
      }
    ): Promise<
      | { status: "saved"; filePath: string; width: number; height: number }
      | { status: "offscreen" }
      | { status: "resized" }
    > => ({
      status: "saved",
      filePath: "/tmp/daintree-clipboard/element-1.png",
      width: 120,
      height: 40,
    })
  );

  const host = {
    picker,
    preview,
    captureElement,
    /** What the host would hash on disk now; a file absent here reads as the fixture source. */
    diskRevisions: new Map<string, FileRevision | null>([[CARD_FILE, CARD_REVISION]]),
    reselectFinds: true,
    currentEpoch: 0,
    /** The workspace the last successful open handed out: what source changes are about by default. */
    workspaceId: WORKSPACE,
    /** The element the page reports by default, and finds again on a reselect. */
    template: (): SelectionObservation => svelteObservation(),
    /** How the workspace opens. */
    openWith: (
      _request: ElementPickerWorkspaceOpenRequest
    ): ElementPickerWorkspaceOpenResult | Promise<ElementPickerWorkspaceOpenResult> => ({
      status: "ready",
      workspaceId: WORKSPACE,
      appPath: ".",
      appPaths: ["."],
      scanComplete: true,
    }),
    /**
     * What the host makes of one element's claims: the fixtures' answers to the
     * claims it carries, so an element never holds a result for a claim it
     * didn't make.
     */
    resultsFor: (
      observation: SelectionObservation,
      _request: ResolveRequest
    ): ResolutionResult[] => {
      const ids = candidateIds(observation);
      return [...svelteResults(), ...reactResults()].filter((result) =>
        ids.has(result.candidateId)
      );
    },
    describeWith: (_request: {
      workspaceId: string;
      url: string;
    }): ProjectContextOutcome | Promise<ProjectContextOutcome> => ({ status: "none" }),
    /** The default answer to a resolve, for a test that holds or wraps it. */
    async answerResolve(request: ResolveRequest): Promise<ResolveResponse> {
      return {
        requestId: request.requestId,
        documentEpoch: request.documentEpoch,
        outcomes: request.observations.map((observation) => ({
          elementId: observation.elementId,
          results: host.resultsFor(observation, request),
        })),
      };
    },
    listenerCounts() {
      return { event: eventListeners.size, source: sourceListeners.size };
    },
    /** The request each call to one of the picker's methods was made with, oldest first. */
    calls<M extends keyof typeof picker>(method: M): Array<Parameters<(typeof picker)[M]>[0]> {
      const recorded: { mock: { calls: ReadonlyArray<readonly unknown[]> } } = picker[method];
      return recorded.mock.calls.map((call) => call[0]) as Array<Parameters<(typeof picker)[M]>[0]>;
    },
    pushPreview(payload: ElementPickerPushPayload) {
      for (const listener of [...eventListeners]) listener(payload);
    },
    pushEvent(event: ElementPickerEvent, epoch?: number, sessionId = "session-1"): void {
      host.pushPreview({
        kind: "picker-event",
        sessionId,
        panelId: "preview-1",
        projectId: "p1",
        documentEpoch: epoch ?? host.currentEpoch,
        sequence: sequence++,
        event,
      });
    },
    documentReady(epoch: number, sessionId = "session-1") {
      host.currentEpoch = epoch;
      host.pushEvent(
        {
          type: "documentReady",
          url: PAGE_URL,
          viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
        },
        epoch,
        sessionId
      );
    },
    select(
      epoch: number,
      observations?: SelectionObservation[],
      cause: "user" | "document" | "reselect" = "user",
      scope: SelectionScope = { kind: "element" }
    ): void {
      host.pushEvent(
        {
          type: "selectionChanged",
          observations: observations ?? [host.template()],
          cause,
          scope,
        },
        epoch
      );
    },
    hover(observation: SelectionObservation | null, epoch?: number): void {
      host.pushEvent(
        { type: "hoverChanged", observation: observation === null ? null : asHover(observation) },
        epoch
      );
    },
    runtimeIssue(
      code: Extract<ElementPickerEvent, { type: "runtimeIssue" }>["code"],
      options: {
        framework?: SelectionObservation["detections"][number]["framework"];
        detail?: string;
        epoch?: number;
      } = {}
    ) {
      host.pushEvent(
        {
          type: "runtimeIssue",
          code,
          ...(options.framework ? { framework: options.framework } : {}),
          detail: options.detail ?? "",
        },
        options.epoch ?? host.currentEpoch
      );
    },
    epochAdvanced(epoch: number) {
      host.pushPreview({
        kind: "epoch-advanced",
        sessionId: "session-1",
        projectId: "p1",
        documentEpoch: epoch,
      });
    },
    sourceChanged(path: string, revision: FileRevision | null = null, workspace?: string): void {
      const workspaceId = workspace ?? host.workspaceId;
      const push: ElementPickerSourceChangedPush = {
        workspaceId,
        panelId: "preview-1",
        file: { workspaceId, path },
        revision,
      };
      for (const listener of [...sourceListeners]) listener(push);
    },
    install(): () => void {
      const previous: unknown = Reflect.get(window, "electron");
      Reflect.set(window, "electron", {
        elementPicker: picker,
        sitePreview: preview,
        webview: { captureElement },
      });
      return () => {
        Reflect.set(window, "electron", previous);
      };
    },
  };
  return host;
}

export type FakeHost = ReturnType<typeof createFakeHost>;
