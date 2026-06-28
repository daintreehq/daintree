// Re-exports the shared CLI socket-path resolver so the CLI and the host
// (`electron/services/PluginCliServer.ts`) resolve the control socket from a
// single source of truth instead of two byte-for-byte copies. The shared module
// is pure node, so tsup bundles it into the standalone CLI without pulling in
// electron.
export {
  getCliSocketPath,
  getCliControlFilePath,
  readCliControlFile,
  type CliControlInfo,
} from "../../../../shared/utils/cliSocketPath.js";
