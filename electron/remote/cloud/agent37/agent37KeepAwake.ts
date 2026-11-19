import { AGENT37_INSTANCE_ID } from "./agent37Schemas.js";

/** The domain every instance's preview URLs live under. */
const PREVIEW_DOMAIN = "agent37.app";

/** The path a keep-awake request takes on the host's listener, ahead of its one-use nonce. */
export const KEEP_AWAKE_PATH = "/daintree-keep-awake/";

/**
 * Why `url` isn't a signed URL for `port` of instance `resourceId`, or null
 * when it is: `https://{resourceId}-{port}.agent37.app` with an `a37_token`,
 * and nothing else that could send the request, or its token, elsewhere.
 * Checked by the Shell before handing a URL over and by the host before it
 * sends anything to it.
 */
export function keepAwakeUrlProblem(url: string, resourceId: string, port: number): string | null {
  const wrong = "That isn't a link to this machine on Agent 37.";
  if (!AGENT37_INSTANCE_ID.test(resourceId)) return wrong;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return wrong;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.hostname !== `${resourceId}-${port}.${PREVIEW_DOMAIN}`
  ) {
    return wrong;
  }
  if (!parsed.searchParams.get("a37_token")) return wrong;
  return null;
}

/** The URL one keep-awake request goes to: the signed URL's origin and token, on the listener's path for `nonce`. */
export function keepAwakeRequestUrl(url: string, nonce: string): URL {
  const target = new URL(url);
  target.pathname = `${KEEP_AWAKE_PATH}${nonce}`;
  target.hash = "";
  return target;
}
