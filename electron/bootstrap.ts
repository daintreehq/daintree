import { enableCompileCache } from "node:module";

enableCompileCache();

await import("./main.js");
