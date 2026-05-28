/**
 * Builds OpenAI HTTP headers (Authorization + optional org/project).
 *
 * Deliberately skips `OpenAI-Organization` and `OpenAI-Project` for `sk-proj-` keys
 * — those keys are auto-scoped to a project at creation time, and sending mismatched
 * org headers produces a false 401 from the API.
 */
export function buildOpenAIHeaders(
  apiKey: string,
  organizationId?: string,
  projectId?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey.trim()}`,
  };
  const isLegacyKey = !apiKey.trim().startsWith("sk-proj-");
  if (isLegacyKey && organizationId?.trim()) {
    headers["OpenAI-Organization"] = organizationId.trim();
  }
  if (isLegacyKey && projectId?.trim()) {
    headers["OpenAI-Project"] = projectId.trim();
  }
  return headers;
}
