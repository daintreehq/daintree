const TRACKING_PARAMS = new Set<string>([
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "_ga",
  "_gl",
  "fbclid",
  "twclid",
  "msclkid",
  "_hsenc",
  "_hsmi",
  "mkt_tok",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "mc_eid",
  "oly_anon_id",
  "oly_enc_id",
  "__s",
  "vero_id",
]);

const TOKEN_FRAGMENT_RE = /[#&?](?:access_token|id_token|token_type)=/i;

function hasAnyAwsSignedParam(params: URLSearchParams): boolean {
  for (const key of params.keys()) {
    if (key.toLowerCase().startsWith("x-amz-")) return true;
  }
  return false;
}

function hasGcsSignedParam(params: URLSearchParams): boolean {
  for (const key of params.keys()) {
    if (key.toLowerCase() === "x-goog-signature") return true;
  }
  return false;
}

function isAzureSasParams(params: URLSearchParams): boolean {
  return params.has("sig") && (params.has("se") || params.has("sv"));
}

export function sanitizeUrlForHistory(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (parsed.username || parsed.password) return null;

  if (TOKEN_FRAGMENT_RE.test(parsed.hash)) return null;

  const params = parsed.searchParams;
  if (params.has("code") && params.has("state")) return null;
  if (hasAnyAwsSignedParam(params)) return null;
  if (hasGcsSignedParam(params)) return null;
  if (isAzureSasParams(params)) return null;

  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();

  const keys = [...params.keys()];
  for (const key of keys) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      params.delete(key);
    }
  }
  params.sort();

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }

  return parsed.toString();
}
