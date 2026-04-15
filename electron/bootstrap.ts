import { enableCompileCache } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { applyLegacyEnvAliases } from "../shared/utils/envCompat.js";

applyLegacyEnvAliases();

const cacheDir = path.join(app.getPath("userData"), "compile-cache");
try {
  fs.mkdirSync(cacheDir, { recursive: true });
  enableCompileCache(cacheDir);
} catch {
  enableCompileCache();
}

await import("./main.js");
