/**
 * Renderer-safe redaction for crash-report surfaces. The main-process
 * `pathScrubber.ts` depends on `os.homedir()`, which is unavailable in the
 * sandboxed renderer, so this module reimplements path scrubbing with the
 * static, username-agnostic patterns only. Secret scrubbing reuses the shared
 * `scrubSecrets` (no Node imports), so there is a single source of truth for
 * secret sigils.
 *
 * Apply at the viewer / report-builder boundary — never at the capture layer.
 * The main-process action-breadcrumb ring stays raw; redaction happens only
 * when content is rendered or built into a shareable report.
 */
import { scrubSecrets } from "./secretScrubber.js";

export { scrubSecrets };

/**
 * Replace user-account segments in common macOS / Linux / Windows paths with a
 * `USER` placeholder. Username-agnostic — uses only static patterns, so it is
 * safe in the renderer where `os.homedir()` is unavailable. Handles both
 * forward-slash and backslash Windows paths (lesson #4979).
 *
 * Every "rest of the segment" class excludes CR and LF. A username cannot
 * contain either, and without that bound a home path sitting at the end of one
 * section of a multi-section report consumes every following section into the
 * replacement — silently truncating the document it was meant to redact.
 * Spaces stay inside the classes: usernames and directories can contain them,
 * and stopping at one would leak the remainder of the name.
 */
export function scrubReportPath(str: string): string {
  return (
    str
      // WSL UNC paths — `\\wsl$\<distro>\home\USER` and
      // `\\wsl.localhost\<distro>\home\USER`. The username lives after the
      // distro segment, so the generic /home/ pattern can't reach it (it uses
      // backslash separators). `[$.]` matches both the `wsl$` and
      // `wsl.localhost` prefixes without `$` acting as an end-of-line anchor.
      // Handle the JSON-doubled backslash form before the raw form. The distro
      // is kept (useful WSL signal); only the username is redacted.
      .replace(/(\\\\\\\\wsl[$.][^\\"\r\n]*\\\\[^\\"\r\n]+\\\\home\\\\)[^\\"\r\n]+/gi, "$1USER")
      .replace(/(\\\\wsl[$.][^\\"\r\n]*\\[^\\"\r\n]+\\home\\)[^\\"\r\n]+/gi, "$1USER")
      // macOS / Linux — the username is the segment after /Users/ or /home/,
      // ending at a path separator, JSON-string quote, or end of string. Matching
      // only the username (not requiring a trailing slash) also catches paths that
      // appear at the end of a JSON value, e.g. `{"cwd":"/Users/alice"}`.
      .replace(/(\/Users\/)[^/"\\\r\n]+/g, "$1USER")
      .replace(/(\/home\/)[^/"\\\r\n]+/g, "$1USER")
      // Windows backslash — JSON.stringify doubles backslashes, so handle the
      // double-backslash form before the single-backslash (raw path) form. The
      // drive letter is generalized to any letter so non-`C:` profiles
      // (e.g. `D:\Users\alice`) are scrubbed too.
      .replace(/([A-Za-z]:\\\\Users\\\\)[^\\"\r\n]+/gi, "$1USER")
      .replace(/([A-Za-z]:\\Users\\)[^\\"\r\n]+/gi, "$1USER")
      // Windows forward-slash form (e.g. from a posix-normalized path).
      .replace(/([A-Za-z]:\/Users\/)[^/"\\\r\n]+/gi, "$1USER")
      // Git remotes — the org/repo segment names private projects. The host is
      // kept (useful signal, same rationale as keeping the WSL distro). SSH
      // form first (a `.git` suffix folds into the redaction — repo names may
      // themselves contain dots), then HTTPS (requires the `.git` suffix so
      // ordinary web URLs in output are left alone). Both replacements
      // re-match to themselves, so the pass stays idempotent.
      .replace(
        // Trailing (?:\/segment)* consumes GitLab nested groups
        // (group/subgroup/repo) so the leaf repo name can't survive.
        /\b(git@[A-Za-z0-9.-]{1,253}:)[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._-]{1,100}){0,10}/g,
        "$1REDACTED/REDACTED"
      )
      .replace(
        // Optional userinfo (`token:x@`) before the host — authenticated
        // remotes must still match here; the credentials themselves are
        // scrubbed later by the url-basic-auth pattern in scrubSecrets.
        /(https?:\/\/(?:[^@/\s"'`]{1,512}@)?[A-Za-z0-9.-]{1,253}\/)(?:[A-Za-z0-9._-]{1,100}\/){0,5}[A-Za-z0-9._-]{1,100}\.git\b/g,
        "$1REDACTED/REDACTED.git"
      )
      // Tilde-relative home paths — the segments after `~/` can name private
      // projects (terminal prompts and agent CWD lines print them constantly),
      // and there is no username segment to scrub selectively, so the whole
      // remainder is collapsed. The lookbehind avoids matching a `~` embedded
      // in a token (e.g. `backup~/file`).
      .replace(/(?<![\w~.-])~\/[^\s"'`)\]}>,;:]+/g, "~/REDACTED")
      // Temp dirs — `/tmp/...` and macOS `/var/folders/...` entries embed
      // usernames and per-session tokens. Also covers `/private/tmp/...`
      // (matched at the inner `/tmp/`).
      .replace(/(\/tmp\/)[^\s"'`)\]}>,;:]+/g, "$1REDACTED")
      .replace(/(\/var\/folders\/)[^\s"'`)\]}>,;:]+/g, "$1REDACTED")
  );
}

/**
 * Full redaction pass for report text: scrub user paths first, then known
 * secret sigils. Idempotent — both passes are.
 */
export function scrubReportText(str: string): string {
  return scrubSecrets(scrubReportPath(str));
}
