import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  PRESENTATION_FEATURE_IDS,
  parsePresentationLevels,
  type PresentationLevels,
} from "../../../shared/config/presentationProfile.js";
import { isFeaturedLaunchEntryRef } from "../../../shared/config/launcherArrangement.js";
import type { PresentationSuggestion } from "../../../shared/types/ipc/projectPresentation.js";

/**
 * A repository's suggested presentation profile, read from
 * `.daintree/presentation.json`:
 *
 * ```json
 * {
 *   "features": { "forgeStats": "hidden", "launcherAgents": "demoted" },
 *   "featuredLaunchEntry": "acme.records.new-record"
 * }
 * ```
 *
 * `featuredLaunchEntry` names one of the project plugin's own launch entries
 * (#13791) as `{publisher.name}.{entry id}`; it only ever preselects a row.
 *
 * A suggestion, never a setting: nothing here changes what the project shows
 * until the user accepts it, and accepting copies the levels into the user's
 * own profile in Daintree's store. Daintree only ever reads this file.
 */
export const PROJECT_PRESENTATION_FILE = [".daintree", "presentation.json"] as const;

const MAX_FILE_BYTES = 64 * 1024;

/**
 * Identity of what the file suggests, not of its bytes: reformatting it, or
 * adding a feature this build does not know, asks nothing new. A file that
 * features no launcher entry hashes exactly as it did before entries could be
 * featured, so the answers already given to it still count.
 */
export function hashPresentationLevels(
  levels: PresentationLevels,
  featuredLaunchEntry?: string
): string {
  const canonical: unknown[] = PRESENTATION_FEATURE_IDS.filter(
    (id) => levels[id] !== undefined
  ).map((id) => [id, levels[id]] as const);
  if (featuredLaunchEntry !== undefined)
    canonical.push(["featuredLaunchEntry", featuredLaunchEntry]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function parsePresentationSuggestion(raw: unknown): PresentationSuggestion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const file = raw as Record<string, unknown>;
  const levels = parsePresentationLevels(file.features);
  const featured = isFeaturedLaunchEntryRef(file.featuredLaunchEntry)
    ? file.featuredLaunchEntry
    : undefined;
  if (Object.keys(levels).length === 0 && featured === undefined) return null;
  return {
    levels,
    ...(featured !== undefined && { featuredLaunchEntry: featured }),
    hash: hashPresentationLevels(levels, featured),
  };
}

/**
 * The file's bytes, or null when what was opened is not the plain file the
 * checks above inspected, or not within the cap. Those checks are a fast path;
 * this is the bound. The open neither follows a final link where the platform
 * allows it nor blocks on a FIFO swapped in after the check, the handle must be
 * the very file inspected — which also catches a link swapped in at either
 * level on a platform without no-follow — and nothing is read past the cap,
 * even if the file grows.
 */
export async function readCapped(
  filePath: string,
  inspected: Stats,
  maxBytes: number = MAX_FILE_BYTES
): Promise<Buffer | null> {
  const flags =
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  const handle = await fs.open(filePath, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    if (stat.dev !== inspected.dev || stat.ino !== inspected.ino) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return length > maxBytes ? null : buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/** The project's suggestion, or null when it has none this build can use. */
export async function readPresentationSuggestion(
  projectRoot: string | null | undefined
): Promise<PresentationSuggestion | null> {
  if (!projectRoot) return null;
  const daintreeDir = path.join(projectRoot, PROJECT_PRESENTATION_FILE[0]);
  const filePath = path.join(projectRoot, ...PROJECT_PRESENTATION_FILE);
  try {
    // Refuse links at either level, as every other `.daintree/` reader does: a
    // link could point this at a file the repository does not own.
    const dirStat = await fs.lstat(daintreeDir);
    if (!dirStat.isDirectory()) return null;
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const bytes = await readCapped(filePath, stat);
    if (bytes === null) return null;
    let content = bytes.toString("utf-8");
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    return parsePresentationSuggestion(JSON.parse(content));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      console.warn(
        `[ProjectPresentation] Ignoring ${PROJECT_PRESENTATION_FILE.join("/")} in ${projectRoot}:`,
        formatErrorMessage(err, "unreadable")
      );
    }
    return null;
  }
}
