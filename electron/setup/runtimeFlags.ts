import { app } from "electron";

// Lightweight runtime flags derived from `app.isPackaged` / `process.argv`.
// Kept separate from the heavy `environment.ts` (which runs `app.getPath`/
// `setPath`, fs, and SQLite work at module load) so importers that only need a
// flag — e.g. `ProjectViewManager` reading `isDemoMode` — don't pull that
// startup machinery into their graph. Same rationale as `deepLinkUrlQueue.ts`.

export const isDemoMode = !app.isPackaged && process.argv.includes("--demo-mode");
export const isSmokeTest = process.argv.includes("--smoke-test");
export const smokeTestStart = isSmokeTest ? Date.now() : 0;
