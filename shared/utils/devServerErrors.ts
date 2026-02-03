/**
 * Error pattern detection for dev server output.
 * Used to identify common failure modes and enable automatic recovery.
 */

export type DevServerErrorType =
  | "port-conflict"
  | "missing-dependencies"
  | "permission"
  | "unknown";

export interface DevServerError {
  type: DevServerErrorType;
  message: string;
  port?: string;
  module?: string;
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

const PERMISSION_ERROR_PATTERNS = [/EACCES/, /permission denied/i, /EPERM/];

export function detectDevServerError(output: string): DevServerError | null {
  // Check for port conflicts first (most specific)
  for (const pattern of PORT_ERROR_PATTERNS) {
    const match = output.match(pattern);
    if (match) {
      const port = match[1] || "unknown";
      return {
        type: "port-conflict",
        message: `Port ${port} is already in use. Stop the other server or use a different port.`,
        port,
      };
    }
  }

  // Check for missing dependencies
  for (const pattern of DEPENDENCY_ERROR_PATTERNS) {
    const match = output.match(pattern);
    if (match) {
      const module = match[1] || undefined;
      return {
        type: "missing-dependencies",
        message: module
          ? `Missing dependency: ${module}. Installing dependencies...`
          : "Missing dependencies detected. Installing...",
        module,
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
