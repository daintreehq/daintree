import { createHash } from "node:crypto";
import { deploymentOf } from "../shared/connection.js";

/**
 * Where a token may go: `"cloud"` for a Cloud API token, which belongs to the
 * account and so suits any Atlassian tenant, or the exact base of the Data
 * Center instance a personal access token was minted by and is only valid on.
 */
export type TokenBinding = "cloud" | (string & {});

export const CLOUD_BINDING = "cloud";

/**
 * Durable record of where the stored token was proven to belong. The host's
 * credential store keeps a bare token, so on a replay (every activation and
 * re-enable) nothing else can say which site it was saved for, and taking the
 * site that happens to be configured is how one instance's token would reach
 * another. Never the token itself: plugin storage is plaintext, so a digest
 * stands in for it, enough to tell a replay of the same token from another.
 */
export interface CredentialProvenance {
  binding: TokenBinding;
  tokenDigest: string;
}

/**
 * `null` when no record has ever been kept, which only an install from before
 * Data Center support can be. `"unknown"` when there should be a record and it
 * can't be read, is malformed, or went missing.
 */
type ProvenanceReader = () => CredentialProvenance | null | "unknown";
type ProvenanceWriter = (record: CredentialProvenance | null) => void;

let provenanceReader: ProvenanceReader | null = null;
let provenanceWriter: ProvenanceWriter | null = null;

let memoryToken: string | null = null;
let tokenBinding: TokenBinding | null = null;
let tokenVersion = 0;

/**
 * Sites candidate tokens were just proven against, by token digest. The host
 * saves with `validateToken(token)` and then `setCredentials(token)`, so this
 * carries the validation's own site across to the save rather than letting the
 * save read the settings again, which may have moved in between. Entries go by
 * age, never by count, so a burst of other checks can't push out the one a save
 * is about to look for.
 */
const provenValidations = new Map<string, { binding: TokenBinding; at: number }>();
const PROVEN_VALIDATION_TTL_MS = 5 * 60_000;

/** Wired by `activate()`, which loads the record before the host replays the token. */
export function setProvenanceAccessors(
  reader: ProvenanceReader | null,
  writer: ProvenanceWriter | null
): void {
  provenanceReader = reader;
  provenanceWriter = writer;
}

export function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The binding a token proven against this normalized site gets. */
export function bindingFor(siteUrl: string): TokenBinding {
  return deploymentOf(siteUrl) === "cloud" ? CLOUD_BINDING : siteUrl;
}

/** A candidate token checked out against this site, so saving it next binds it there. */
export function recordProvenValidation(token: string, siteUrl: string): void {
  const now = Date.now();
  for (const [digest, entry] of provenValidations) {
    if (now - entry.at > PROVEN_VALIDATION_TTL_MS) provenValidations.delete(digest);
  }
  provenValidations.set(digestToken(token), { binding: bindingFor(siteUrl), at: now });
}

function provenBindingFor(digest: string): TokenBinding | undefined {
  const entry = provenValidations.get(digest);
  if (!entry) return undefined;
  if (Date.now() - entry.at > PROVEN_VALIDATION_TTL_MS) {
    provenValidations.delete(digest);
    return undefined;
  }
  return entry.binding;
}

/**
 * Where a token arriving from the host belongs: the site a validation of it just
 * proved, else the durable record of an earlier save. Before Data Center was
 * supported nothing was recorded and every saved token was a Cloud one, so a
 * token from such an install is taken as Cloud, once, and recorded that way.
 * A record for some other token, or one that can't be known, binds nothing.
 */
function resolveBinding(token: string): TokenBinding | null {
  const digest = digestToken(token);
  const proven = provenBindingFor(digest);
  if (proven !== undefined) {
    provenanceWriter?.({ binding: proven, tokenDigest: digest });
    return proven;
  }
  const recorded = provenanceReader ? provenanceReader() : null;
  if (recorded === "unknown") return null;
  if (recorded === null) {
    provenanceWriter?.({ binding: CLOUD_BINDING, tokenDigest: digest });
    return CLOUD_BINDING;
  }
  return recorded.tokenDigest === digest ? recorded.binding : null;
}

/**
 * Forget the in-memory token and any proofs without touching the durable
 * record: what an activation does before the host replays, so a save that
 * finished on a retired provider can't leave its token live.
 */
export function resetTokenState(): void {
  provenValidations.clear();
  if (memoryToken === null && tokenBinding === null) return;
  memoryToken = null;
  tokenBinding = null;
  tokenVersion++;
}

export function getToken(): string | null {
  return memoryToken;
}

/** Bumps whenever the token or where it may go changes, so caches can't outlive either. */
export function getTokenVersion(): number {
  return tokenVersion;
}

/** Whether the in-memory token may be sent to this normalized site. */
export function tokenMayGoTo(siteUrl: string): boolean {
  return tokenBinding !== null && tokenBinding === bindingFor(siteUrl);
}

/**
 * Replace the in-memory token. Its binding comes from {@link resolveBinding}
 * unless `siteUrl` names the site outright. Clearing drops the durable record
 * and any proofs too, even when nothing was in memory: a clear while the plugin
 * was disabled must not let a later replay bring the record back.
 */
export function setMemoryToken(token: string | null, siteUrl?: string): void {
  const next = token?.trim() ? token.trim() : null;
  if (next === null) {
    provenanceWriter?.(null);
    provenValidations.clear();
  }
  const binding =
    next === null ? null : siteUrl !== undefined ? bindingFor(siteUrl) : resolveBinding(next);
  if (next === memoryToken && binding === tokenBinding) return;
  memoryToken = next;
  tokenBinding = binding;
  tokenVersion++;
}
