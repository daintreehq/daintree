#!/usr/bin/env node
// Puts Canopy's reader model where the build and an unpackaged run read it
// (electron/resources/canopy-reader), fetching only what is missing or wrong.
// `--check` only verifies, and never touches the network.
//
//   node scripts/fetch-canopy-model.mjs
//   node scripts/fetch-canopy-model.mjs --check
import path from "node:path";
import canopyReaderModel from "./lib/canopyReaderModel.cjs";

const { MODEL_DIR, invalidFiles, prepareModel } = canopyReaderModel;
const where = path.relative(process.cwd(), MODEL_DIR) || MODEL_DIR;

try {
  if (process.argv.includes("--check")) {
    const bad = invalidFiles(MODEL_DIR);
    if (bad.length > 0) {
      console.error(
        `[canopy-reader] ${where} is missing or has wrong: ${bad.map((f) => f.name).join(", ")}`
      );
      process.exit(1);
    }
    console.log(`[canopy-reader] ${where} matches the pinned revision`);
  } else {
    const { fetched } = await prepareModel();
    console.log(
      fetched.length > 0
        ? `[canopy-reader] Fetched ${fetched.join(", ")} into ${where}`
        : `[canopy-reader] ${where} already matches the pinned revision`
    );
  }
} catch (error) {
  console.error(`[canopy-reader] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
