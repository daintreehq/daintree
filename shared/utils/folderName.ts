import { WINDOWS_RESERVED_NAMES } from "./pathPattern.js";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1F]/;
const WIN32_ILLEGAL_CHARS = /[<>:"|?*]/;
const PATH_SEPARATORS = /[/\\]/;
const TRAILING_DOT_OR_SPACE = /[. ]$/;

const MAX_NAME_LENGTH = 255;
const utf8 = new TextEncoder();

export interface ValidateFolderNameOptions {
  /**
   * Platform of the machine that will create the folder, as `process.platform`
   * spells it. A renderer in a view bound to another host must pass that host's
   * platform, because its own `process` is absent and its machine isn't where
   * the folder lands. Omitted, it is this process's platform when there is one.
   */
  platform?: string;
}

function defaultPlatform(): string | undefined {
  return typeof process !== "undefined" && typeof process.platform === "string"
    ? process.platform
    : undefined;
}

/**
 * NTFS and APFS/HFS+ bound a name by characters (255 UTF-16 units covers all
 * three), but Linux bounds it by UTF-8 bytes, so 100 CJK characters fit on a Mac
 * and fail with ENAMETOOLONG on ext4. An unknown platform keeps only the unit
 * limit.
 */
function limitsNameInBytes(platform: string | undefined): boolean {
  return platform === "linux";
}

/**
 * Whether `name`, exactly as it will be written, is too long for one directory
 * entry on the platform. For callers whose naming policy is their own, such as a
 * relocation that must not reject names it already accepts.
 */
export function folderNameLengthError(
  name: string,
  options: ValidateFolderNameOptions = {}
): string | null {
  if (name.length > MAX_NAME_LENGTH) return "Folder name is too long";
  if (
    limitsNameInBytes(options.platform ?? defaultPlatform()) &&
    utf8.encode(name).length > MAX_NAME_LENGTH
  ) {
    return `Folder name is too long (${MAX_NAME_LENGTH} bytes max; some characters use several)`;
  }
  return null;
}

/**
 * Validate a single folder-name segment for project creation. Returns a
 * user-facing error string if invalid, or `null` if the name is acceptable.
 *
 * Used by both renderer dialogs and main-process IPC handlers so all three
 * project-add paths apply the same rules. Pure string logic — no Node APIs
 * beyond a guarded `process.platform` read — so it imports cleanly from either
 * side of the contextBridge.
 */
export function validateFolderName(
  name: string,
  options: ValidateFolderNameOptions = {}
): string | null {
  if (typeof name !== "string") return "Folder name is required";
  const trimmed = name.trim();
  if (!trimmed) return "Folder name is required";
  if (trimmed === "." || trimmed === "..") return "Invalid folder name";

  const lengthError = folderNameLengthError(trimmed, options);
  if (lengthError) return lengthError;

  if (PATH_SEPARATORS.test(trimmed)) {
    return "Folder name must not contain path separators";
  }
  if (CONTROL_CHARS.test(trimmed)) {
    return "Folder name must not contain control characters";
  }
  if (WIN32_ILLEGAL_CHARS.test(trimmed)) {
    return 'Folder name must not contain < > : " | ? or *';
  }

  // Win32 silently strips trailing dot/space at creation, which can collapse
  // distinct names or produce reserved-name collisions; reject on the raw
  // input so a user-typed `foo ` isn't quietly normalized to `foo`.
  if (TRAILING_DOT_OR_SPACE.test(name) || TRAILING_DOT_OR_SPACE.test(trimmed)) {
    return "Folder name must not end with a space or period";
  }

  // Leading dash is a tooling hazard — argv parsers (git, shells) treat it as
  // a flag.
  if (trimmed.startsWith("-")) {
    return "Folder name must not start with '-'";
  }

  // Win32 reserved-name check: strip extension and compare the stem
  // case-insensitively. CON, NUL.txt, COM1.log, etc. are all blocked.
  const dotIndex = trimmed.indexOf(".");
  const stem = dotIndex === -1 ? trimmed : trimmed.slice(0, dotIndex);
  if (WINDOWS_RESERVED_NAMES.has(stem.toUpperCase())) {
    return `Folder name uses Windows-reserved name '${stem}'`;
  }

  return null;
}
