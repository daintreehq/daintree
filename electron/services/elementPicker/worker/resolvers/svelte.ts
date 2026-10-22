import { loadParse } from "@daintreehq/svelte-source-model";
import type { SvelteEvidence } from "../../../../../shared/elementPicker/evidence.js";
import type { SelectionObservation } from "../../../../../shared/elementPicker/observation.js";
import type { ResolutionResult } from "../../../../../shared/elementPicker/resolution.js";
import type { SourceCandidate } from "../../../../../shared/elementPicker/source.js";
import type {
  HostSourceResolver,
  ResolveResponse,
} from "../../../../../shared/elementPicker/resolver.js";
import { unavailableResult } from "../../outcomes.js";
import { SvelteJob } from "./svelte/context.js";
import {
  resolveDefinition,
  resolveInvocation,
  type InvocationOutcome,
} from "./svelte/components.js";
import { resolveFileHint, resolveTemplateLocation } from "./svelte/elements.js";

/**
 * The Svelte resolver: what Svelte's dev runtime reported about a selected
 * node, checked against the `.svelte` source it names. Any Svelte 5 app, with
 * or without SvelteKit; this module and the compiler it parses with load only
 * when a request carries a Svelte candidate.
 *
 * What it reads in a request, as the Svelte extractor reports it:
 *
 * - An element's `template-location` (or `element-creation`): where
 *   `__svelte_meta.loc` says the element is written, or `location: null` for
 *   an element the page could not stamp. Answered `verified` with the
 *   element's range once the file has that element there, placed by the
 *   `structure` in the observation's Svelte evidence when the stamp is
 *   contradicted or missing.
 * - A component record's `component-invocation`: the call site a `component`
 *   frame of `__svelte_meta.parent` names. Answered `verified` with the tag's
 *   range, and with the file its import binds the tag to when the call site's
 *   source proves one.
 * - A record's `component-definition` or `file-hint`: held to what that same
 *   call site proves.
 * - An element's `file-hint`: read and named, never checked.
 *
 * Anything else is `unsupported`. Paths are reported relative to the Vite
 * root, which is the app root; main locates them, so nothing here knows where
 * either root is.
 */
export const svelteResolver: HostSourceResolver = {
  framework: "svelte",
  async resolve(request, access, signal): Promise<ResolveResponse> {
    const job = new SvelteJob(request, access, signal, await loadParse());
    const outcomes: ResolveResponse["outcomes"] = [];
    // One observation at a time: candidates in one file share its read and
    // its parse, and a resolve that interleaved them would only parse more.
    for (const observation of request.observations) {
      outcomes.push({
        elementId: observation.elementId,
        results: await resolveObservation(job, observation),
      });
    }
    return { requestId: request.requestId, documentEpoch: request.documentEpoch, outcomes };
  },
};

async function resolveObservation(
  job: SvelteJob,
  observation: SelectionObservation
): Promise<ResolutionResult[]> {
  const evidence = observation.frameworkEvidence.find(
    (entry): entry is SvelteEvidence => entry.kind === "svelte"
  );
  // Work not begun when the job was withdrawn is `cancelled`, even where the
  // bytes it needs were already read: an answer is what the job finished.
  const unlessCancelled = (
    candidate: SourceCandidate,
    work: () => Promise<ResolutionResult>
  ): Promise<ResolutionResult> =>
    job.cancelled ? Promise.resolve(unavailableResult(candidate, "cancelled")) : work();
  const results: ResolutionResult[] = [];
  for (const candidate of observation.sourceCandidates) {
    switch (candidate.kind) {
      case "template-location":
      case "element-creation":
        results.push(
          await unlessCancelled(candidate, () =>
            resolveTemplateLocation(job, observation, candidate, evidence)
          )
        );
        break;
      case "file-hint":
        results.push(await unlessCancelled(candidate, () => resolveFileHint(job, candidate)));
        break;
      default:
        results.push(unavailableResult(candidate, "unsupported"));
    }
  }
  for (const record of observation.componentChain.components) {
    let invocation: InvocationOutcome | null = null;
    const answered = new Map<string, ResolutionResult>();
    for (const candidate of record.sourceCandidates) {
      if (candidate.kind !== "component-invocation") continue;
      const outcome: InvocationOutcome = job.cancelled
        ? {
            result: unavailableResult(candidate, "cancelled"),
            proof: { status: "stopped", reason: "cancelled" },
          }
        : await resolveInvocation(job, candidate, evidence);
      // The record's definition is held to its first call site, the one that
      // rendered this copy; a second is answered on its own.
      invocation ??= outcome;
      answered.set(candidate.candidateId, outcome.result);
    }
    for (const candidate of record.sourceCandidates) {
      const result = answered.get(candidate.candidateId);
      if (result) {
        results.push(result);
        continue;
      }
      results.push(
        candidate.kind === "component-definition" || candidate.kind === "file-hint"
          ? await unlessCancelled(candidate, () => resolveDefinition(job, candidate, invocation))
          : unavailableResult(candidate, "unsupported")
      );
    }
  }
  return results;
}
