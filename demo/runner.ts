import { parseArgs } from "node:util";
import path from "node:path";
import { launchApp, closeApp } from "../e2e/helpers/launch.js";
import { Stage } from "./stage.js";
import type { ScenarioConfig } from "./stage.js";
import type { DemoEncodePayload } from "../shared/types/ipc/demo.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    scenario: { type: "string", short: "s" },
    output: { type: "string", short: "o" },
    preset: { type: "string", short: "p" },
    fps: { type: "string", short: "f" },
    "keep-frames": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (!values.scenario) {
  console.error(
    "Usage: tsx demo/runner.ts --scenario <name> [--output <path>] [--preset <preset>] [--fps <number>]"
  );
  process.exit(1);
}

const scenarioName = values.scenario;
const scenarioPath = path.resolve(import.meta.dirname, "scenes", `${scenarioName}.ts`);

async function run(): Promise<void> {
  console.log(`Loading scenario: ${scenarioName}`);
  const mod = (await import(scenarioPath)) as { default: ScenarioConfig };
  const config = mod.default;

  const outputPath = values.output ?? config.outputFile;
  const preset = (values.preset ?? config.preset) as DemoEncodePayload["preset"];
  const fps = values.fps ? parseInt(values.fps, 10) : (config.fps ?? 30);

  console.log(`Launching Electron in demo mode...`);
  const { app, window } = await launchApp({
    extraArgs: ["--demo-mode"],
  });

  let framesDir: string | null = null;

  try {
    const stage = await Stage.create(window);
    console.log(`Stage ready. Running ${config.scenes.length} scene(s)...`);

    const capture = await stage.startCapture({ fps });
    framesDir = capture.outputDir;
    console.log(`Capturing at ${fps} fps → ${framesDir}`);

    for (let i = 0; i < config.scenes.length; i++) {
      console.log(`  Scene ${i + 1}/${config.scenes.length}...`);
      await config.scenes[i]!(stage);
    }

    const stopResult = await stage.stopCapture();
    console.log(`Captured ${stopResult.frameCount} frames.`);

    if (stopResult.frameCount === 0) {
      console.error("No frames captured — skipping encode.");
      process.exitCode = 1;
      return;
    }

    const resolvedOutput = path.resolve(outputPath);
    console.log(`Encoding → ${resolvedOutput} (preset: ${preset})...`);
    const result = await stage.encode({
      framesDir: stopResult.outputDir,
      outputPath: resolvedOutput,
      preset,
      fps,
    });
    console.log(`Done in ${(result.durationMs / 1000).toFixed(1)}s → ${result.outputPath}`);
  } catch (err) {
    console.error("Scene failed:", err);
    // Stop capture to free timer if still running
    try {
      await Stage.create(window).then((s) => s.stopCapture());
    } catch {
      // Already stopped or app crashed
    }
    process.exitCode = 1;
  } finally {
    await closeApp(app);
  }
}

run().catch((err) => {
  console.error("Runner error:", err);
  process.exit(1);
});
