/**
 * Forge-agnostic profile-picture resolution.
 *
 * A `ProfilePictureProvider` maps a commit-author email to that author's
 * avatar URL on a specific forge (GitHub first; GitLab, Bitbucket, Codeberg,
 * and any future forge follow the same shape). It is the source-of-truth tier
 * above Gravatar in the committer-chip avatar fallback chain (#8514).
 *
 * The contract is deliberately thin: implementations own their own caching,
 * rate-limit handling, and network-error recovery. Callers only ever see
 * `string | null` — a resolved URL, or `null` when no profile matches the
 * email (including the rate-limited / unauthenticated cases, which resolve to
 * `null` rather than surfacing backoff state).
 *
 * Type-only module — zero runtime behavior — so the renderer, main process,
 * and the workspace-host UtilityProcess can all import it without dragging a
 * provider implementation across a process boundary. Concrete providers live
 * in the main process next to their forge's auth/request infrastructure.
 */
export interface ProfilePictureProvider {
  /**
   * Canonical forge provider id this implementation serves — matches the
   * `{pluginId}.{contributionId}` ids from `shared/utils/forgeProviderIds.ts`
   * (e.g. {@link BUILTIN_GITHUB_PROVIDER_ID}). The consumer hook uses this to
   * route an author email to the right forge.
   */
  readonly providerId: string;

  /**
   * Resolve an avatar URL for `email`. Returns the URL on success, or `null`
   * when no profile matches, the request was rate-limited, or auth is
   * unavailable — never throws for those cases. `signal` aborts an in-flight
   * lookup when the caller unmounts.
   */
  resolveByEmail(email: string, signal?: AbortSignal): Promise<string | null>;
}
