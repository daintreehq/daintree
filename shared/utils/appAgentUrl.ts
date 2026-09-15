import { isLoopbackHostname } from "./urlUtils.js";

export const APP_AGENT_DEFAULT_BASE_URL = "https://api.fireworks.ai/inference/v1";

export type AppAgentUrlResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Resolve the chat-completions endpoint the App Agent sends its API key to. The
 * transport check runs on the final endpoint URL, not the raw base, so query,
 * fragment, or userinfo tricks in the base cannot move the request to another host.
 */
export function resolveAppAgentChatCompletionsUrl(baseUrl: string | undefined): AppAgentUrlResult {
  let url: URL;
  try {
    url = new URL(`${baseUrl || APP_AGENT_DEFAULT_BASE_URL}/chat/completions`);
  } catch {
    return { ok: false, error: "Invalid base URL configured" };
  }

  if (url.protocol === "https:") {
    return { ok: true, url: url.toString() };
  }
  if (url.protocol === "http:") {
    if (isLoopbackHostname(url.hostname)) {
      return { ok: true, url: url.toString() };
    }
    return { ok: false, error: "Base URL must use HTTPS except for loopback hosts" };
  }
  return { ok: false, error: "Invalid base URL configured" };
}
