// Manifest authors and permission scopes.

import path from "node:path";
import { z } from "zod";
import { refinePluginHttpsUrl } from "./common.js";

/**
 * Per-entry validator for `scopes.network.allowedUrls`. See
 * {@link refinePluginHttpsUrl} for the enforced discipline.
 */
const PluginAllowedUrlSchema = z.string().superRefine((value, ctx) => {
  refinePluginHttpsUrl(value, ctx, "scopes.network.allowedUrls");
});

/**
 * Per-entry validator for `authors[].url`. Author homepage links surface as
 * user-clickable buttons in the plugin detail pane, so they carry the same
 * https-only, no-credentials, no-private-host discipline as network scopes
 * (anti-phishing / SSRF) — only the error-message field name differs.
 */
const PluginAuthorUrlSchema = z.string().superRefine((value, ctx) => {
  refinePluginHttpsUrl(value, ctx, "authors[].url");
});

/**
 * A single attribution entry in the plugin manifest's `authors` array. `name`
 * is required; `url`, `email`, and `role` are optional. `strictObject` rejects
 * unknown keys so manifest typos surface loudly.
 */
export const PluginAuthorSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  url: PluginAuthorUrlSchema.optional(),
  email: z.email().optional(),
  role: z.string().trim().min(1).max(50).optional(),
});

/**
 * Matches a dynamic scope token (`${project}` / `${worktree}`) at the start of
 * an `allowedPaths` entry, with an optional `/sub/path` suffix. These expand at
 * call time against the live active project / worktree root (PluginService),
 * letting a plugin scope to "the active worktree" without a hardcoded path.
 */
const ALLOWED_PATH_TOKEN_RE = /^\$\{(?:project|worktree)\}(?:\/.*)?$/;

/**
 * Per-entry validator for `scopes.fs.allowedPaths`. Each entry must be either a
 * literal absolute path or a dynamic scope token (`${project}` / `${worktree}`,
 * optionally with a `/sub/path` suffix), with no `..` segment and no `*` glob —
 * the schema boundary is the load-bearing gate (#4593, #4702), so substring
 * `..` checks are insufficient (segment-by-segment rejection).
 */
const PluginAllowedPathSchema = z.string().superRefine((value, ctx) => {
  if (value.includes("*")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Wildcard characters are not allowed in scopes.fs.allowedPaths: "${value}"`,
      params: { errorCode: "scope_wildcard_rejected" },
    });
    return;
  }
  const isToken = ALLOWED_PATH_TOKEN_RE.test(value);
  if (!isToken && !path.isAbsolute(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `scopes.fs.allowedPaths entries must be absolute paths or a "\${project}"/"\${worktree}" token: "${value}"`,
      params: { errorCode: "scope_path_relative" },
    });
    return;
  }
  const segments = value.split(/[\\/]/);
  if (segments.some((seg) => seg === "..")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `scopes.fs.allowedPaths entries must not contain ".." segments: "${value}"`,
      params: { errorCode: "scope_path_traversal" },
    });
    return;
  }
});

export const PluginNetworkScopeSchema = z
  .object({
    allowedUrls: z.array(PluginAllowedUrlSchema).min(1),
  })
  .strict();

/**
 * `scopes.fs.allowedPaths` is enforced at runtime: the host-mediated
 * `host.fs` / `host.git` surface realpath-contains every path argument to these
 * roots (PluginService), rejecting traversal and symlink escapes. Entries may be
 * literal absolute paths or `${project}` / `${worktree}` tokens that expand at
 * call time against the live active project / worktree. Independently, every
 * plugin is always granted an implicit per-plugin data root
 * (`~/.daintree/plugin-data/{pluginId}/`) so `allowedPaths` is optional.
 */
export const PluginFsScopeSchema = z
  .object({
    allowedPaths: z.array(PluginAllowedPathSchema).min(1),
  })
  .strict();

/**
 * A declared local socket endpoint: a Unix-domain socket path or a Windows
 * named pipe (`\\.\pipe\name`).
 *
 * Deliberately does NOT reuse {@link PluginAllowedPathSchema}: that validator
 * leans on `path.isAbsolute`, which is platform-dependent, so a manifest
 * declaring `\\.\pipe\docker_engine` would fail to parse on macOS and a
 * manifest declaring `/var/run/docker.sock` would fail on Windows. A manifest
 * must validate identically everywhere it's read — including when a Linux CI
 * box parses a plugin authored for Windows — so both forms are accepted on
 * every platform and the shape is checked explicitly.
 *
 * This is disclosure metadata, not an enforcement boundary (nothing intercepts
 * `node:net`), so the checks target author mistakes and misleading UI rather
 * than containment: no globs (a wildcard would render as a specific endpoint
 * while meaning any), no traversal segments, no NUL, no relative paths.
 */
const LOCAL_SOCKET_PATH_MAX = 512;

export const PluginAllowedSocketPathSchema = z
  .string()
  .min(1)
  .max(LOCAL_SOCKET_PATH_MAX)
  .superRefine((value, ctx) => {
    const addIssue = (message: string): void => {
      ctx.addIssue({ code: "custom", message });
    };
    if (value.trim() !== value) {
      addIssue("Socket path must not have leading or trailing whitespace");
      return;
    }
    if (value.includes("\0")) {
      addIssue("Socket path must not contain a NUL character");
      return;
    }
    if (value.includes("*")) {
      addIssue("Socket path must not contain a wildcard — declare each endpoint literally");
      return;
    }
    const isWindowsPipe = /^\\\\[.?]\\pipe\\/i.test(value);
    if (isWindowsPipe) {
      if (value.length <= "\\\\.\\pipe\\".length) {
        addIssue("Windows named pipe must include a pipe name");
        return;
      }
    } else if (!value.startsWith("/")) {
      addIssue(
        "Socket path must be an absolute Unix-domain path (/var/run/docker.sock) or a Windows named pipe (\\\\.\\pipe\\name)"
      );
      return;
    }
    // Traversal is rejected for both forms. Splitting on either separator
    // matters because the check has to hold for a Windows pipe name parsed on
    // a POSIX host, where `path` would never treat `\` as a separator.
    if (value.split(/[/\\]/).includes("..")) {
      addIssue("Socket path must not contain a '..' segment");
    }
  });

/**
 * `scopes.socket.allowedPaths` — optional path intent for `socket:connect`
 * (#11299). Unlike `scopes.fs`, nothing enforces this: a plugin's `main` calls
 * `node:net` directly with no host interception point. It exists so the
 * Permissions tab can render "connects to /var/run/docker.sock" instead of the
 * bare capability, which is the whole value of the disclosure.
 */
export const PluginLocalSocketScopeSchema = z
  .object({
    allowedPaths: z.array(PluginAllowedSocketPathSchema).min(1),
  })
  .strict();

/**
 * Top-level `scopes` field on `PluginManifest`. Strict so a misspelled scope
 * bucket (e.g. `networking` instead of `network`) surfaces as a manifest error
 * rather than silently failing to attenuate the compound-capability lattice.
 */
export const PluginManifestScopesSchema = z
  .object({
    network: PluginNetworkScopeSchema.optional(),
    fs: PluginFsScopeSchema.optional(),
    socket: PluginLocalSocketScopeSchema.optional(),
  })
  .strict();
