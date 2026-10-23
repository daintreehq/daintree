import type {
  HostSourceResolver,
  ResolveRequest,
  ResolveResponse,
  ResolverSourceAccess,
  RevisionedSource,
  RevisionedSourceMap,
  SourceAccessResult,
} from "../../../../shared/elementPicker/resolver.js";
import type { SourceFileRef } from "../../../../shared/elementPicker/resolution.js";
import type { ElementPickerProviderId } from "../../../../shared/elementPicker/source.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import type { HostInbound, HostOutbound } from "../hostProtocol.js";
import { mergeAnswers, observationCandidates, requestFor, unavailableResult } from "../outcomes.js";

/**
 * The host process's dispatcher, apart from the process itself so it can be
 * driven over any channel. It has no file or network access of its own: a
 * resolver's every read is a message to main, answered with bytes.
 */

/**
 * One explicit `import()` per framework, so loading a request's resolver loads
 * that resolver and nothing else. Never a barrel, and never a specifier built
 * from the request. The core host's are a fixed list of core frameworks; a
 * plugin's resolver host's are the providers main told it to load.
 */
export type ResolverLoaders = Partial<
  Record<ElementPickerProviderId, () => Promise<HostSourceResolver>>
>;

export interface HostRuntime {
  handle(message: HostInbound): void;
}

interface RuntimeJob {
  readonly controller: AbortController;
  readonly pending: Map<number, (result: SourceAccessResult<unknown>) => void>;
}

/**
 * What the wire carries. Main retires a host that sends more, so an access
 * that would not fit is refused here instead of costing every job in flight.
 */
const URL_LIMIT = 2048;
const SOURCE_LIMIT = 4096;
/** What a page may report as a file, and so the longest path the wire carries. */
const REPORTED_FILE_LIMIT = 2048;

function fitsWire(value: string, limit: number): boolean {
  return value.length > 0 && value.length <= limit;
}

/** Bounded: the wire refuses a longer one. */
function errorMessage(error: unknown): string {
  return formatErrorMessage(error, "resolver failed").slice(0, 1024);
}

/**
 * A resolver's answer, checked against the request it was given before it is
 * merged away: merging takes the current request's ids, so an answer for an
 * earlier request or document would otherwise pass as this one's.
 */
function checkAnswer(
  framework: string,
  request: ResolveRequest,
  answer: ResolveResponse
): ResolveResponse {
  const fail = (what: string): never => {
    throw new Error(`the ${framework} resolver ${what}`);
  };
  if (answer.requestId !== request.requestId || answer.documentEpoch !== request.documentEpoch) {
    fail("answered a different request");
  }
  const candidates = new Map(
    request.observations.map((observation) => [
      observation.elementId,
      new Set(observationCandidates(observation).map((candidate) => candidate.candidateId)),
    ])
  );
  const answered = new Set<string>();
  for (const outcome of answer.outcomes) {
    const owned = candidates.get(outcome.elementId);
    if (!owned || answered.has(outcome.elementId)) fail("answered an element it was not sent");
    answered.add(outcome.elementId);
    const results = new Set<string>();
    for (const result of outcome.results) {
      if (!owned!.has(result.candidateId) || results.has(result.candidateId)) {
        fail("answered a candidate it was not sent, or one twice");
      }
      results.add(result.candidateId);
    }
  }
  return answer;
}

export function createHostRuntime(
  post: (message: HostOutbound) => void,
  loaders: ResolverLoaders
): HostRuntime {
  const jobs = new Map<number, RuntimeJob>();
  const loaded = new Map<string, Promise<HostSourceResolver>>();
  let nextAccessId = 1;

  function load(framework: string): Promise<HostSourceResolver> | null {
    // Own keys only: an id the page sent must never reach a prototype member.
    // A framework this host has no loader for answers `unsupported`.
    const loader = Object.hasOwn(loaders, framework) ? loaders[framework] : undefined;
    if (!loader) return null;
    let resolver = loaded.get(framework);
    if (!resolver) {
      resolver = loader().catch((error: unknown) => {
        // A failed import is not cached: a transient failure must not disable
        // the framework for the rest of this process.
        loaded.delete(framework);
        throw error;
      });
      loaded.set(framework, resolver);
    }
    return resolver;
  }

  function access(jobId: number, job: RuntimeJob): ResolverSourceAccess {
    const ask = <T>(
      message: (accessId: number) => HostOutbound,
      signal: AbortSignal
    ): Promise<SourceAccessResult<T>> => {
      if (signal.aborted || job.controller.signal.aborted) {
        return Promise.resolve({ ok: false, reason: "cancelled" });
      }
      const accessId = nextAccessId++;
      return new Promise((resolve) => {
        const settle = (result: SourceAccessResult<unknown>) => {
          if (!job.pending.delete(accessId)) return;
          signal.removeEventListener("abort", onAbort);
          resolve(result as SourceAccessResult<T>);
        };
        const onAbort = () => settle({ ok: false, reason: "cancelled" });
        job.pending.set(accessId, settle);
        signal.addEventListener("abort", onAbort, { once: true });
        post(message(accessId));
      });
    };
    return {
      readSource: (file, signal) =>
        ask<RevisionedSource>(
          (accessId) => ({ type: "read-source", jobId, accessId, file }),
          signal
        ),
      fetchSourceMap: (generatedUrl, signal) =>
        fitsWire(generatedUrl, URL_LIMIT)
          ? ask<RevisionedSourceMap>(
              (accessId) => ({ type: "fetch-source-map", jobId, accessId, generatedUrl }),
              signal
            )
          : Promise.resolve({ ok: false, reason: "map-missing" }),
      locateSource: ({ generatedUrl, source, sourceRoot }, signal) =>
        !fitsWire(generatedUrl, URL_LIMIT) ||
        source.length > SOURCE_LIMIT ||
        (sourceRoot !== null && sourceRoot.length > SOURCE_LIMIT)
          ? Promise.resolve({ ok: false, reason: "unsupported" })
          : ask<SourceFileRef>(
              (accessId) => ({
                type: "locate-source",
                jobId,
                accessId,
                generatedUrl,
                source,
                sourceRoot,
              }),
              signal
            ),
      locateFile: (reported, signal) =>
        !fitsWire(reported, REPORTED_FILE_LIMIT)
          ? Promise.resolve({ ok: false, reason: "outside-workspace" })
          : ask<SourceFileRef>(
              (accessId) => ({ type: "locate-file", jobId, accessId, reported }),
              signal
            ),
    };
  }

  async function run(jobId: number, job: RuntimeJob, request: ResolveRequest): Promise<void> {
    const { signal } = job.controller;
    const frameworks = [
      ...new Set(
        request.observations.flatMap((observation) =>
          observationCandidates(observation).map((candidate) => candidate.framework)
        )
      ),
    ];
    const sourceAccess = access(jobId, job);
    const answers = new Map<string, ResolveResponse | "cancelled" | null>();
    await Promise.all(
      frameworks.map(async (framework) => {
        const resolver = load(framework);
        if (!resolver) {
          answers.set(framework, null);
          return;
        }
        const own = requestFor(request, (candidate) => candidate.framework === framework);
        try {
          answers.set(
            framework,
            checkAnswer(framework, own, await (await resolver).resolve(own, sourceAccess, signal))
          );
        } catch (error) {
          if (!signal.aborted) throw error;
          answers.set(framework, "cancelled");
        }
      })
    );

    const response = mergeAnswers(
      request,
      (candidate) => {
        const answer = answers.get(candidate.framework);
        return answer && answer !== "cancelled" ? answer : null;
      },
      (candidate) => {
        const answer = answers.get(candidate.framework);
        if (answer === null || answer === undefined)
          return unavailableResult(candidate, "unsupported");
        if (answer === "cancelled") return unavailableResult(candidate, "cancelled");
        return unavailableResult(candidate, signal.aborted ? "cancelled" : "unsupported");
      }
    );
    post({ type: "resolved", jobId, response });
  }

  return {
    handle(message) {
      switch (message.type) {
        case "resolve": {
          if (jobs.has(message.jobId)) return;
          const job: RuntimeJob = { controller: new AbortController(), pending: new Map() };
          jobs.set(message.jobId, job);
          void run(message.jobId, job, message.request)
            .catch((error: unknown) => {
              // The other frameworks' resolvers are answering a job that has failed.
              job.controller.abort();
              post({ type: "failed", jobId: message.jobId, message: errorMessage(error) });
            })
            .finally(() => {
              jobs.delete(message.jobId);
              for (const settle of job.pending.values()) settle({ ok: false, reason: "cancelled" });
            });
          return;
        }
        case "cancel": {
          const job = jobs.get(message.jobId);
          if (!job) return;
          job.controller.abort();
          // A resolver may have passed a signal of its own to a read; the job's
          // cancel still ends it, so nothing is left waiting on main.
          for (const settle of [...job.pending.values()])
            settle({ ok: false, reason: "cancelled" });
          return;
        }
        case "access-result":
          jobs.get(message.jobId)?.pending.get(message.accessId)?.(message.result);
          return;
        case "dispose":
          return;
      }
    },
  };
}
