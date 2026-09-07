import { printUsage, REGISTRY } from "./registry";

// Single entry point for every performance benchmark. Each command spawns the
// underlying benchmark in its own process (clean argv, faithful exit code) so a
// benchmark runs identically to being invoked directly. Add a benchmark by
// adding one REGISTRY entry in `registry.ts` — package.json and this file never
// grow a per-benchmark script again.
//
//   npm run perf list                              # show every command
//   npm run perf smoke -- --scenario PERF-105      # measure ONE benchmark
//   npm run perf cold-start -- --runs 10
//
// The four mode commands each require `--scenario` with exactly one id. There
// is no whole-matrix run: this harness exists for targeted optimisation work
// driven by `.agents/skills/optimize`, one benchmark at a time.
//
// The table itself lives in `registry.ts` so tests can read it without this
// file's `main()` dispatching a command as a side effect of the import.

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (
    command === undefined ||
    command === "list" ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    printUsage();
    process.exit(0);
  }

  const entry = REGISTRY[command];
  if (!entry) {
    console.error(`[perf] unknown command: ${command}\n`);
    printUsage();
    process.exit(1);
  }

  process.exit(await entry.runner(rest));
}

main().catch((error) => {
  console.error("[perf] fatal:", error);
  process.exit(1);
});
