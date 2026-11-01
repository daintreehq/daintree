// One static Main graph keeps the lifecycle singleton shared with writeback,
// including on Windows where dynamic .js imports can resolve separately.
export { ProjectStateManager } from "../../ProjectStateManager.js";
export { generateProjectId } from "../../projectStorePaths.js";
export { getLifecycleLedger, disposeLifecycleLedger } from "../lifecycleLedger.js";
export {
  acceptObservedAgentSession,
  writeBackCapturedSessionId,
  resetCapturedSessionPersistenceForTests,
} from "../agentSessionCapturePersistence.js";
export { offerAgentRunArgvSession } from "../agentRunArgv.js";
export { events } from "../../events.js";
