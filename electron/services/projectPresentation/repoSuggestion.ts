import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  PRESENTATION_FEATURE_IDS,
  parsePresentationLevels,
  type PresentationLevels,
} from "../../../shared/config/presentationProfile.js";
import type { PresentationSuggestion } from "../../../shared/types/ipc/projectPresentation.js";

/**
 * A repository's suggested presentation profile, read from
 * `.daintree/presentation.json`:
 *
 * ```json
 * { "features": { "forgeStats": "hidden" } }
 * ```
 *
 * A suggestion, never a setting: nothing here changes what the project shows
 * until the user accepts it, and accepting copies the levels into the user's
 * own profile in Daintree's store. Daintree only ever reads this file.
 */
export const PROJECT_PRESENTATION_FILE = [".daintree", "presentation.json"] as const;

const MAX_FILE_BYTES = 64 * 1024;

/**
 * Identity of what the file suggests, not of its bytes: reformatting it, or
 * adding a feature this build does not know, asks nothing new.
 */
export function hashPresentationLevels(levels: PresentationLevels): string {
  const canonical = PRESENTATION_FEATURE_IDS.filter((id) => levels[id] !== undefined).map(
    (id) => [id, levels[id]] as const
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function parsePresentationSuggestion(raw: unknown): PresentationSuggestion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const levels = parsePresentationLevels((raw as Record<string, unknown>).features);
  if (Object.keys(levels).length === 0) return null;
  return { levels, hash: hashPresentationLevels(levels) };
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
    let content = await fs.readFile(filePath, "utf-8");
    // The file can grow between the lstat and the read.
    if (Buffer.byteLength(content, "utf-8") > MAX_FILE_BYTES) return null;
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
