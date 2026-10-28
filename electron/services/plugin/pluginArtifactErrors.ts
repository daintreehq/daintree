export type PluginArtifactErrorCode =
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_TOO_LARGE"
  | "ARTIFACT_QUOTA_EXCEEDED"
  | "ARTIFACT_BUSY"
  | "ARTIFACT_URL_NOT_ALLOWED"
  | "ARTIFACT_TRANSFER_FAILED"
  | "ARTIFACT_REMOTE_UNSUPPORTED"
  | "ARTIFACT_SOURCE_UNSUPPORTED"
  | "PERMISSION_REQUIRED"
  | "PLUGIN_UNLOADED"
  | "INVALID_PATH"
  | "VALIDATION";

/** An Error whose message leads with its code, as the host's other coded errors do. */
export function artifactError(
  code: PluginArtifactErrorCode,
  message: string
): Error & { code: PluginArtifactErrorCode } {
  const error = new Error(`${code}: ${message}`) as Error & { code: PluginArtifactErrorCode };
  error.code = code;
  return error;
}

export function isArtifactErrorCode(error: unknown, code: PluginArtifactErrorCode): boolean {
  return (error as { code?: unknown } | null)?.code === code;
}
