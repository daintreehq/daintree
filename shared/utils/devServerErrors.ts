/**
 * Error pattern detection for dev server output.
 * Used to identify common failure modes and enable automatic recovery.
 */

export type DevServerErrorType =
  | "port-conflict"
  | "missing-dependencies"
  | "permission"
  | "compile-error"
  | "oom"
  | "process-crash"
  | "unknown";

export interface DevServerError {
  type: DevServerErrorType;
  message: string;
  port?: string;
  module?: string;
  /**
   * Built-in action ID the stuck-start escalation banner should surface as
   * the variant-specific remedy. Kept as a soft string to avoid a cyclic
   * dependency on `shared/types/actions.ts`.
   */
  recommendedActionId?: string;
}

const PORT_ERROR_PATTERNS = [
  /EADDRINUSE.*:(\d+)/,
  /port (\d+) is already in use/i,
  /address already in use.*:(\d+)/i,
  /listen EADDRINUSE.*:(\d+)/,
  /Error: listen EADDRINUSE: address already in use :::(\d+)/,
  /Something is already running on port (\d+)/i,
  /Port (\d+) is in use/i,
];

const DEPENDENCY_ERROR_PATTERNS = [
  /Cannot find module '([^']+)'/,
  /Error: Cannot find module '([^']+)'/,
  /MODULE_NOT_FOUND/,
  /Cannot find package '([^']+)'/,
  /Error \[ERR_MODULE_NOT_FOUND\]/,
  /npm ERR! missing/i,
  /The module '([^']+)' was compiled/,
  /Error: ENOENT.*node_modules/,
];

// Failure-specific compile patterns. Deliberately distinct from UrlDetector's
// COMPILE_MARKERS which detect active compilation ("compiling...", "[vite] hmr
// update") — those signal progress; these signal failure.
const COMPILE_ERROR_PATTERNS = [
  /Build failed with \d+ errors?/i,
  /Compilation failed/i,
  /Failed to compile/i,
  /Module build failed/i,
  /Unable to resolve module/i,
  /Could not resolve/i,
  /error TS\d+:/i,
];

const PERMISSION_ERROR_PATTERNS = [/EACCES/, /permission denied/i, /EPERM/];

/** Every pattern detectDevServerError can report from, for the trigger contract below. */
export const DEV_SERVER_ERROR_PATTERNS: readonly RegExp[] = [
  ...PORT_ERROR_PATTERNS,
  ...DEPENDENCY_ERROR_PATTERNS,
  ...COMPILE_ERROR_PATTERNS,
  ...PERMISSION_ERROR_PATTERNS,
];

/**
 * Case-insensitive literals of which every pattern above contains at least one,
 * so `detectDevServerError` returns null for text containing none of them.
 * UrlDetector uses this to skip re-running the patterns over its whole buffer
 * once the last trigger has scrolled out — add a literal for any new pattern.
 * The auto-retry guard needs none: it only ever suppresses a port match.
 */
export const DEV_SERVER_ERROR_TRIGGERS = [
  "eaddrinuse",
  "already in use",
  "already running",
  "is in use",
  "cannot find module",
  "module_not_found",
  "cannot find package",
  "npm err! missing",
  "the module '",
  "enoent",
  "build failed with",
  "compilation failed",
  "failed to compile",
  "module build failed",
  "unable to resolve module",
  "could not resolve",
  "error ts",
  "eacces",
  "permission denied",
  "eperm",
];

export function detectDevServerError(output: string): DevServerError | null {
  // Check for port conflicts first (most specific)
  const autoRetryPortMessage = /port .* in use.*trying another/i.test(output);
  if (!autoRetryPortMessage) {
    for (const pattern of PORT_ERROR_PATTERNS) {
      const match = output.match(pattern);
      if (match) {
        const port = match[1] || "unknown";
        return {
          type: "port-conflict",
          message: `Port ${port} is already in use. Stop the other server or use a different port.`,
          port,
          recommendedActionId: "devPreview.restartAndClearCache",
        };
      }
    }
  }

  // Check for missing dependencies
  for (const pattern of DEPENDENCY_ERROR_PATTERNS) {
    const match = output.match(pattern);
    if (match) {
      const module = match[1] || undefined;
      return {
        type: "missing-dependencies",
        message: module ? `Missing dependency: ${module}` : "Missing dependencies detected",
        module,
        recommendedActionId: "devPreview.reinstallAndRestart",
      };
    }
  }

  // Check for compile errors
  for (const pattern of COMPILE_ERROR_PATTERNS) {
    if (pattern.test(output)) {
      return {
        type: "compile-error",
        message: "Compilation failed. Check the terminal output for details.",
      };
    }
  }

  // Check for permission errors
  for (const pattern of PERMISSION_ERROR_PATTERNS) {
    if (pattern.test(output)) {
      return {
        type: "permission",
        message: "Permission denied. Check file permissions or run with elevated privileges.",
      };
    }
  }

  return null;
}

export function isRecoverableError(error: DevServerError): boolean {
  return error.type === "missing-dependencies";
}
