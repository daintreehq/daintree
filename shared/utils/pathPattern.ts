const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:\//;

const path = {
  isAbsolute: (input: string): boolean => /^([A-Za-z]:[\\/]|[\\/])/.test(input),

  normalize: (input: string): string => {
    const source = input.replace(/\\/g, "/");
    if (source.length === 0) return ".";

    let prefix = "";
    let rest = source;

    if (WINDOWS_DRIVE_PREFIX.test(source)) {
      prefix = source.slice(0, 3);
      rest = source.slice(3);
    } else if (source.startsWith("/")) {
      prefix = "/";
      rest = source.slice(1);
    }

    const segments = rest.split("/").filter((segment) => segment.length > 0);
    const normalizedSegments: string[] = [];

    for (const segment of segments) {
      if (segment === ".") continue;
      if (segment === "..") {
        if (
          normalizedSegments.length > 0 &&
          normalizedSegments[normalizedSegments.length - 1] !== ".."
        ) {
          normalizedSegments.pop();
        } else if (!prefix) {
          normalizedSegments.push("..");
        }
        continue;
      }
      normalizedSegments.push(segment);
    }

    const joined = normalizedSegments.join("/");

    if (prefix) {
      if (!joined) return prefix;
      return prefix.endsWith("/") ? `${prefix}${joined}` : `${prefix}/${joined}`;
    }

    return joined || ".";
  },

  basename: (input: string): string => {
    const normalized = path.normalize(input);
    if (normalized === "/" || WINDOWS_DRIVE_PREFIX.test(normalized)) return "";
    const parts = normalized.split("/");
    return parts[parts.length - 1] || "";
  },

  dirname: (input: string): string => {
    const normalized = path.normalize(input);
    if (normalized === "/" || WINDOWS_DRIVE_PREFIX.test(normalized)) return normalized;

    const parts = normalized.split("/");
    parts.pop();
    const dir = parts.join("/");

    if (!dir) {
      return path.isAbsolute(normalized) ? "/" : ".";
    }
    return dir;
  },

  resolve: (...paths: string[]): string => {
    let resolved = "";
    for (const segment of paths) {
      if (!segment) continue;
      if (path.isAbsolute(segment)) {
        resolved = segment;
      } else {
        resolved = resolved ? `${resolved}/${segment}` : segment;
      }
    }
    return path.normalize(resolved || ".");
  },
};

export interface PathPatternVariables {
  "base-folder": string;
  "branch-slug": string;
  "repo-name": string;
  "parent-dir": string;
}

export const DEFAULT_WORKTREE_PATH_PATTERN = "{parent-dir}/{base-folder}-worktrees/{branch-slug}";

export function sanitizeBranchName(branchName: string): string {
  return branchName
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function resolvePathPattern(
  pattern: string,
  variables: PathPatternVariables,
  rootPath: string
): string {
  let resolved = pattern;

  for (const [key, value] of Object.entries(variables)) {
    resolved = resolved.replace(new RegExp(`\\{${key}\\}`, "g"), value);
  }

  if (!path.isAbsolute(resolved)) {
    resolved = path.resolve(rootPath, resolved);
  }

  return path.normalize(resolved);
}

export function buildPathPatternVariables(
  rootPath: string,
  branchName: string
): PathPatternVariables {
  const baseFolder = path.basename(rootPath);
  const parentDir = path.dirname(rootPath);
  const branchSlug = sanitizeBranchName(branchName);

  return {
    "base-folder": baseFolder,
    "branch-slug": branchSlug,
    "repo-name": baseFolder,
    "parent-dir": parentDir,
  };
}

export function generateWorktreePath(
  rootPath: string,
  branchName: string,
  pattern: string = DEFAULT_WORKTREE_PATH_PATTERN
): string {
  const variables = buildPathPatternVariables(rootPath, branchName);
  return resolvePathPattern(pattern, variables, rootPath);
}

export function validatePathPattern(pattern: string): { valid: boolean; error?: string } {
  if (!pattern || pattern.trim().length === 0) {
    return { valid: false, error: "Pattern cannot be empty" };
  }

  if (path.isAbsolute(pattern) && !pattern.startsWith("{parent-dir}")) {
    return {
      valid: false,
      error: "Absolute paths are not allowed (use {parent-dir} for parent directory)",
    };
  }

  if (pattern.includes("..")) {
    return {
      valid: false,
      error: "Path traversal (..) is not allowed for security reasons",
    };
  }

  const validVariables = ["{base-folder}", "{branch-slug}", "{repo-name}", "{parent-dir}"];
  const variablePattern = /\{[^}]+\}/g;
  const matches = pattern.match(variablePattern) || [];

  for (const match of matches) {
    if (!validVariables.includes(match)) {
      return {
        valid: false,
        error: `Unknown variable: ${match}. Valid variables: ${validVariables.join(", ")}`,
      };
    }
  }

  if (!pattern.includes("{branch-slug}")) {
    return {
      valid: false,
      error: "Pattern must include {branch-slug} to create unique paths",
    };
  }

  return { valid: true };
}

export function previewPathPattern(
  pattern: string,
  rootPath: string,
  sampleBranch: string = "feature/example-branch"
): string {
  try {
    return generateWorktreePath(rootPath, sampleBranch, pattern);
  } catch {
    return "Invalid pattern";
  }
}
