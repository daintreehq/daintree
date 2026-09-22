import { createRequire } from "node:module";

// Read from package.json at load time so `--version` can never drift from
// what npm published; `../package.json` resolves from both `src/` and `dist/`.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export const CLI_VERSION: string = version;
