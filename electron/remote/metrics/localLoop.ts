import { createHostSampleSources } from "./hostSources.js";
import { HostMetricsSampler } from "./sampler.js";
import { SummaryLoop } from "./summaryLoop.js";

let shared: SummaryLoop | null = null;

/** This machine's one loop, built on first use so nothing samples until something listens. */
export function getLocalSummaryLoop(): SummaryLoop {
  shared ??= new SummaryLoop(new HostMetricsSampler(createHostSampleSources()));
  return shared;
}
