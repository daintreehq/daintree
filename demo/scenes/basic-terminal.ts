import { SEL } from "../../e2e/helpers/selectors.js";
import type { ScenarioConfig, Scene } from "../stage.js";

const openTerminal: Scene = async (stage) => {
  await stage.wait.forSelector(SEL.toolbar.openTerminal);
  await stage.sleep(500);
  await stage.cursor.click(SEL.toolbar.openTerminal);
  await stage.wait.forSelector(SEL.terminal.xtermHelperTextarea, { timeoutMs: 10_000 });
  await stage.sleep(800);
};

const typeCommand: Scene = async (stage) => {
  await stage.keyboard.type(SEL.terminal.xtermHelperTextarea, 'echo "Hello from Daintree!"', {
    cps: 12,
  });
  await stage.sleep(1500);
};

export default {
  outputFile: "demo-output/basic-terminal.mp4",
  preset: "youtube-1080p",
  fps: 30,
  scenes: [openTerminal, typeCommand],
} satisfies ScenarioConfig;
