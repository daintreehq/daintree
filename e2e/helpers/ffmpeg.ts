import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Optional binary downloads can fail without failing npm install. Resolve at
// runtime so unrelated suites can still load and typecheck without FFmpeg.
export function resolveFfmpeg(): string | null {
  let entry: string;
  try {
    entry = require.resolve("ffmpeg-static");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return null;
    throw error;
  }
  return require(entry) as string | null;
}
