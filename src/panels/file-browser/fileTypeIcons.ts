/**
 * File-type icons for the browser tree (#11596).
 *
 * Every row used to render the same generic `File`, so a folder of `.mp4`
 * clips looked exactly like a folder of source files.
 *
 * Only the glyph vocabulary and its Tailwind classes live here. The
 * classification itself — the extension and basename tables, and the patterns
 * that catch `.eslintrc.json` and friends — is shared with plugins through
 * `@daintreehq/plugin-sdk/files`, so a plugin rendering its own file list gets
 * the same categories without inheriting our icon set. Keeping the two apart is
 * what lets the SDK half ship without `lucide-react` or a Tailwind vocabulary.
 *
 * Glyphs only: every icon paints the same neutral.
 */

import {
  Binary,
  Database,
  File,
  FileArchive,
  FileBraces,
  FileCode,
  FileCog,
  FileImage,
  FileKey,
  FileLock,
  FileMusic,
  FilePlay,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  type LucideIcon,
} from "lucide-react";
// Relative into the package source, matching `src/hooks/useHostChannel.ts`:
// the host bundle and the published SDK then run identical classification code.
import {
  getFileTypeCategory,
  type FileTypeCategory,
} from "../../../packages/plugin-sdk/src/files/fileTypeCategory";

/**
 * The one neutral every tree entry icon paints in, file and folder alike.
 *
 * A complete Tailwind literal, never composed at runtime: the v4 scanner only
 * emits utilities it can find as whole strings in source.
 *
 * Secondary, and specifically NOT muted. Pre-#11596 these icons were
 * `text-daintree-text/30` (files) and `/40` (folders), which on a dark panel
 * is ~2.4:1 — under the 3:1 floor for a graphical object, and the "near
 * invisible" bug #11596 set out to fix. Muted looks like the tidier choice
 * because it sits a step below the `/70` filename it labels, but it is only
 * floored for light themes in `shared/theme/contrast.ts`: dark muted runs a
 * sanctioned sub-AA calibration that bottoms out at 2.22:1 on namib and
 * 2.50:1 on redwoods, which would reintroduce the original bug on two of the
 * seven dark themes. Secondary is guarded at >=3.0 on every surface in every
 * theme and measures >=4.96:1 across all fourteen, so it is the only tier
 * that holds. Anything quieter needs an all-theme, all-surface proof first.
 */
export const FILE_TREE_ICON_COLOR_CLASS = "text-text-secondary";

/**
 * Marker class on every tree entry icon, file and folder alike. Carries no
 * styling of its own — it exists so `@media (prefers-contrast: more)` in
 * `src/index.css` can lift the whole set to the solid text token. Exported so
 * the component and the stylesheet's contract test agree on one spelling.
 */
export const FILE_TREE_ICON_CLASS = "file-tree-entry-icon";

export interface FileTypeIcon {
  category: FileTypeCategory;
  Icon: LucideIcon;
}

/**
 * One glyph per category, and no two alike: with color gone the shape is the
 * only channel left, so a duplicate here would erase a category outright
 * rather than merely weakening it.
 */
const CATEGORIES: Record<FileTypeCategory, FileTypeIcon> = {
  source: { category: "source", Icon: FileCode },
  font: { category: "font", Icon: FileType },
  script: { category: "script", Icon: FileTerminal },
  audio: { category: "audio", Icon: FileMusic },
  data: { category: "data", Icon: FileBraces },
  spreadsheet: { category: "spreadsheet", Icon: FileSpreadsheet },
  config: { category: "config", Icon: FileCog },
  video: { category: "video", Icon: FilePlay },
  lock: { category: "lock", Icon: FileLock },
  document: { category: "document", Icon: FileText },
  image: { category: "image", Icon: FileImage },
  key: { category: "key", Icon: FileKey },
  archive: { category: "archive", Icon: FileArchive },
  binary: { category: "binary", Icon: Binary },
  database: { category: "database", Icon: Database },
  unknown: { category: "unknown", Icon: File },
};

/**
 * Icon and category for one tree row, keyed off its name alone.
 *
 * Classification is the SDK's; this only maps the answer onto a glyph.
 */
export function getFileTypeIcon(filePath: string): FileTypeIcon {
  return CATEGORIES[getFileTypeCategory(filePath)];
}

export type { FileTypeCategory };
