import { getRuntimePlatform } from "./distribution.js";

/**
 * Where the Daintree Assistant's own engine can run.
 *
 * The vendored engine takes an exclusive per-project lease before it opens its database
 * — a `flock`, chosen because the kernel releases it on process death, which is exactly
 * the handover its supervisor listens for. That lock has no Windows implementation:
 * `internal/ipc/lock_other.go` fails loudly rather than pretending to exclude, and
 * `internal/cli/host.go` takes the lease on the way in. So on Windows the engine does
 * not degrade, it fails to boot, reporting `ipc: file locks are not supported on this
 * platform`. The upstream engine's own release workflow excludes Windows for the same
 * reason.
 *
 * Worth stating plainly: this is about the built-in ENGINE, not the assistant panel.
 * The panel happily hosts Claude, Codex and the rest, and the engine's terminal path is
 * no fallback — it takes the same lease.
 *
 * Shared because both processes need the answer and must not disagree: main refuses to
 * spawn, and the renderer has to say why instead of presenting a launch that dies.
 */

export type AssistantPlatformSupport =
  { supported: true } | { supported: false; reason: string; detail: string };

/**
 * Platforms Daintree supports the built-in engine on.
 *
 * An allowlist, and a product decision rather than a transcription of the Go build
 * constraint — that constraint is `unix`, which is broader than these two (it includes
 * AIX and the BSDs). Anything outside this set is refused rather than guessed at, which
 * is the safe direction: the cost of being wrong here is an explained limitation, and in
 * the other direction it is a child process that dies at boot.
 */
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);

/**
 * Whether the engine can run on a platform, and what to say when it cannot.
 *
 * The copy lives here so the surfaces that show it cannot drift into describing the
 * limitation differently.
 *
 * Resolved through `getRuntimePlatform` rather than `process.platform`: this module is
 * imported by the renderer, where `process` is deliberately not exposed — reading it
 * there is a `ReferenceError`, not a fallback.
 */
export function assistantPlatformSupport(
  platform: string = getRuntimePlatform()
): AssistantPlatformSupport {
  if (SUPPORTED_PLATFORMS.has(platform)) return { supported: true };
  return {
    supported: false,
    // Names the ENGINE, not the panel — the panel still works, with another agent in it.
    reason:
      platform === "win32"
        ? "The built-in assistant isn't available on Windows"
        : "The built-in assistant isn't available on this platform",
    // Not "Windows has no file locking" — it does. What has not been ported is this
    // engine's own project lock. And the sentence has to end somewhere the user can go,
    // or an unsupported state is a support ticket by construction.
    detail:
      "Its project lock hasn't been ported yet. Pick Claude, Codex or another installed agent in assistant settings.",
  };
}
