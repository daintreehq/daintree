import { parseArgs } from "node:util";
import path from "node:path";
import { launchApp, closeApp } from "../e2e/helpers/launch.js";
import { Stage } from "./stage.js";
import type { ScenarioConfig } from "./stage.js";
import type { DemoEncodePreset } from "../shared/types/ipc/demo.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    scenario: { type: "string", short: "s" },
    output: { type: "string", short: "o" },
    preset: { type: "string", short: "p" },
    fps: { type: "string", short: "f" },
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
  const preset = (values.preset ?? config.preset) as DemoEncodePreset;
  const parsedFps = values.fps ? parseInt(values.fps, 10) : (config.fps ?? 30);
  const fps = Number.isFinite(parsedFps) && parsedFps > 0 ? parsedFps : 30;

  console.log(`Launching Electron in demo mode...`);
  const { app, window } = await launchApp({
    extraArgs: ["--demo-mode"],
  });

  let stage: Stage | undefined;
  try {
    stage = await Stage.create(window);
    console.log(`Stage ready. Running ${config.scenes.length} scene(s)...`);

    const resolvedOutput = path.resolve(outputPath);
    const capture = await stage.startCapture({ fps, outputPath: resolvedOutput, preset });
    console.log(`Capturing at ${fps} fps → ${capture.outputPath}`);

    for (let i = 0; i < config.scenes.length; i++) {
      console.log(`  Scene ${i + 1}/${config.scenes.length}...`);
      await config.scenes[i]!(stage);
    }

    const stopResult = await stage.stopCapture();
    console.log(`Captured ${stopResult.frameCount} frames.`);

    if (stopResult.frameCount === 0) {
      console.error("No frames captured.");
      process.exitCode = 1;
      return;
    }

    console.log(`Done → ${stopResult.outputPath}`);
  } catch (err) {
    console.error("Scene failed:", err);
    try {
      await stage?.stopCapture();
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
