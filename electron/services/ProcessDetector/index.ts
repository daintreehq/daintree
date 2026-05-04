export { ProcessDetector } from "./ProcessDetector.js";
export type { DetectionResult } from "./ProcessDetector.js";
export type { DetectionCallback } from "./types.js";
export type { CommandIdentity } from "./types.js";
export type { DetectionState, DetectionEvidenceSource } from "./types.js";
export {
  makeAgentResult,
  makeNoAgentResult,
  makeUnknownResult,
  makeAmbiguousResult,
} from "./types.js";
export {
  extractCommandNameCandidates,
  extractScriptBasenameFromCommand,
  redactArgv,
  detectCommandIdentity,
} from "./commandParser.js";
