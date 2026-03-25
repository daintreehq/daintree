export * from "./types.js";
export type { SpawnContext } from "./terminalSpawn.js";
export { AgentStateService } from "./AgentStateService.js";
export { TerminalRegistry } from "./TerminalRegistry.js";
export { TerminalProcess } from "./TerminalProcess.js";
export {
  ensureUtf8Locale,
  filterEnvironment,
  injectCanopyMetadata,
  isSensitiveVar,
  type CanopyTerminalMetadata,
} from "./EnvironmentFilter.js";
export {
  AgentPatternDetector,
  createPatternDetector,
  stripAnsi,
  AGENT_PATTERN_CONFIGS,
  UNIVERSAL_PATTERN_CONFIG,
  type PatternDetectionConfig,
  type PatternDetectionResult,
} from "./AgentPatternDetector.js";
