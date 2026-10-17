// One static Main graph keeps the lifecycle singleton shared with writeback,
// including on Windows where dynamic .js imports can resolve separately.
export { ProjectStateManager } from "../../ProjectStateManager.js";
export { generateProjectId } from "../../projectStorePaths.js";
export { getLifecycleLedger, disposeLifecycleLedger } from "../lifecycleLedger.js";
export {
  writeBackCapturedSessionId,
  resetCapturedSessionPersistenceForTests,
} from "../agentSessionCapturePersistence.js";
