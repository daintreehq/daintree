import { enableCompileCache } from "node:module";
import fs from "node:fs";
import path from "node:path";

const userData = process.env.CANOPY_USER_DATA;
if (userData) {
  try {
    const cacheDir = path.join(userData, "compile-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    enableCompileCache(cacheDir);
  } catch {
    enableCompileCache();
  }
} else {
  enableCompileCache();
}

await import("./pty-host.js");
