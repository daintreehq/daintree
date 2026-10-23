import { EventEmitter } from "node:events";
import type {
  HostSourceResolver,
  ResolveRequest,
  ResolveResponse,
} from "../../../../shared/elementPicker/resolver.js";
import type { SelectionObservation } from "../../../../shared/elementPicker/observation.js";
import type {
  ElementPickerFramework,
  ElementPickerProviderId,
  SourceCandidate,
} from "../../../../shared/elementPicker/source.js";
import type { ResolutionResult } from "../../../../shared/elementPicker/resolution.js";
import type { HostChild } from "../ElementPickerHost.js";
import type { HostInbound, HostOutbound } from "../hostProtocol.js";
import { observationCandidates, unavailableResult } from "../outcomes.js";
import { createHostRuntime, type HostRuntime, type ResolverLoaders } from "../worker/runtime.js";

const unknown = { state: "unknown" } as const;

export function candidate(
  candidateId: string,
  file: string,
  framework: ElementPickerProviderId = "svelte"
): SourceCandidate {
  return {
    kind: "file-hint",
    candidateId,
    framework,
    extraction: { kind: "runtime-field", field: "__meta" },
    file,
  };
}

export function observation(
  elementId: string,
  sourceCandidates: SourceCandidate[],
  componentCandidates: SourceCandidate[] = []
): SelectionObservation {
  return {
    phase: "selection",
    elementId,
    tagName: "div",
    label: "",
    bounds: [],
    detections: [],
    componentChain: {
      nearestId: componentCandidates.length > 0 ? `${elementId}-component` : null,
      components:
        componentCandidates.length > 0
          ? [
              {
                componentId: `${elementId}-component`,
                framework: componentCandidates[0]!.framework,
                name: null,
                environment: "client",
                rootElementIds: [elementId],
                rootsComplete: true,
                sourceCandidates: componentCandidates,
              },
            ]
          : [],
      truncated: false,
    },
    sourceCandidates,
    capabilities: {
      names: unknown,
      chain: unknown,
      componentSelection: unknown,
      file: unknown,
      line: unknown,
      exactRange: unknown,
    },
    frameworkEvidence: [],
  };
}

let nextRequest = 1;

export function request(
  workspaceId: string,
  observations: SelectionObservation[],
  budget: Partial<ResolveRequest["budget"]> = {}
): ResolveRequest {
  return {
    requestId: `request-${nextRequest++}`,
    sessionId: "session",
    documentEpoch: 3,
    workspaceId,
    observations,
    knownRevisions: [],
    budget: {
      maxFiles: 32,
      maxFileBytes: 1024 * 1024,
      maxNetworkRequests: 8,
      maxNetworkBytes: 4 * 1024 * 1024,
      deadlineMs: 5_000,
      ...budget,
    },
  };
}

/**
 * Reads every candidate's file through the host and claims it: `verified`
 * when the file holds the marker, a `mismatch` naming what it read when not,
 * and whatever the host refused the read with otherwise.
 */
export const STUB_MARKER = "stub-resolvable";

export function stubResolver(framework: ElementPickerFramework = "svelte"): HostSourceResolver {
  const decoder = new TextDecoder();
  return {
    framework,
    async resolve(request, access, signal): Promise<ResolveResponse> {
      return {
        requestId: request.requestId,
        documentEpoch: request.documentEpoch,
        outcomes: await Promise.all(
          request.observations.map(async (observation) => ({
            elementId: observation.elementId,
            results: await Promise.all(
              observationCandidates(observation).map(async (source): Promise<ResolutionResult> => {
                const file = { workspaceId: request.workspaceId, path: source.file };
                const read = await access.readSource(file, signal);
                if (!read.ok) return unavailableResult(source, read.reason);
                const { revision, bytes } = read.value;
                if (!decoder.decode(bytes).includes(STUB_MARKER)) {
                  return {
                    ...unavailableResult(source, "mismatch"),
                    read: { file, fileRevision: revision },
                  } as ResolutionResult;
                }
                return {
                  state: "verified",
                  candidateId: source.candidateId,
                  claim: source.kind,
                  target: { file, location: null },
                  fileRevision: revision,
                };
              })
            ),
          }))
        ),
      };
    },
  };
}

/** Never answers until its signal aborts, and then only if `honour` says so. */
export function stallingResolver(honour: boolean, onEnter?: () => void): HostSourceResolver {
  return {
    framework: "svelte",
    resolve: (request, _access, signal) =>
      new Promise((resolve) => {
        onEnter?.();
        if (!honour) return;
        signal.addEventListener("abort", () =>
          resolve({
            requestId: request.requestId,
            documentEpoch: request.documentEpoch,
            outcomes: [],
          })
        );
      }),
  };
}

let nextPid = 1000;

export interface RuntimeChildOptions {
  /** False: never spawns until the test calls `start()`. */
  start?: boolean;
  /** False: spawns but never says ready, as a host wedged in its bootstrap would. */
  ready?: boolean;
  /** True: ignores `dispose`, so only a kill ends it. */
  ignoreDispose?: boolean;
}

/**
 * A utility process stand-in that runs the real host runtime. Every message
 * is structured-cloned and delivered on a later turn, as the process boundary
 * would, so nothing shares a reference with main.
 */
export class RuntimeChild extends EventEmitter implements HostChild {
  pid: number | undefined = undefined;
  alive = true;
  readonly posted: HostInbound["type"][] = [];
  private readonly runtime: HostRuntime;

  constructor(
    loaders: ResolverLoaders,
    private readonly options: RuntimeChildOptions = {}
  ) {
    super();
    this.runtime = createHostRuntime((message) => this.deliver(message), loaders);
    if (options.start !== false) setImmediate(() => this.start());
  }

  start(): void {
    if (!this.alive) return;
    this.pid = nextPid++;
    this.emit("spawn");
    if (this.options.ready !== false) this.deliver({ type: "ready" });
  }

  postMessage(message: HostInbound): void {
    if (!this.alive) return;
    this.posted.push(message.type);
    const copy = structuredClone(message);
    setImmediate(() => {
      if (!this.alive) return;
      if (copy.type === "dispose") {
        if (!this.options.ignoreDispose) this.exit(0);
        return;
      }
      this.runtime.handle(copy);
    });
  }

  /** Sends a message as the host would, bypassing the runtime. */
  deliver(message: HostOutbound | Record<string, unknown>): void {
    const copy = structuredClone(message);
    setImmediate(() => {
      if (this.alive) this.emit("message", copy);
    });
  }

  exit(code: number): void {
    if (!this.alive) return;
    this.alive = false;
    this.emit("exit", code);
  }
}
