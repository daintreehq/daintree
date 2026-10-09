/**
 * A fake `claude` that draws an agent's screen the way Claude Code does, for
 * specs that need Canopy to read realistic terminals: a body of output, the
 * input box under it with whatever the user types echoed into it, and the
 * status footer. Working scenes tick a spinner and emit the OSC 9;4 heartbeat
 * `AgentStateService` reads, so the real state machine moves the agent between
 * working and waiting.
 *
 * Each instance draws the scene in `<binDir>/scenes/<DAINTREE_PANE_ID>.json`,
 * re-read as the spec rewrites it (`setFakeCanopyScene`). Before one is
 * written it sits at an empty prompt.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

export interface FakeCanopyScene {
  /** Rows above the input box, newest last. `{t}` is replaced by seconds since the scene began. */
  lines: string[];
  /** Spinner and heartbeat: the agent is at work. */
  working?: boolean;
  /** The spinner's word, e.g. "Testing". */
  spinner?: string;
  /** Rows added below `lines` one at a time, every `streamEveryMs`, while working. */
  stream?: string[];
  streamEveryMs?: number;
  /** Draw the input box and footer. A dialog replaces them; default true. */
  box?: boolean;
}

interface Config {
  dir: string;
  version: string;
}

function fakeCanopyProgram(config: Config, fs: typeof import("fs"), path: typeof import("path")) {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${config.version} (Claude Code)\n`);
    process.exit(0);
  }
  const ESC = "\u001b";
  const OSC_WORKING = `${ESC}]9;4;1;0\u0007`;
  const OSC_IDLE = `${ESC}]9;4;0;0\u0007`;
  const sceneFile = path.join(config.dir, `${process.env.DAINTREE_PANE_ID ?? "pane"}.json`);
  let scene: FakeCanopyScene = {
    lines: ["▐▛███▜▌   Claude Code v" + config.version, "", "Ready when you are."],
  };
  let sceneText = "";
  let sceneAt = Date.now();
  let draft = "";
  let wasWorking = false;

  const write = (text: string) => process.stdout.write(text);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  function frame(): string {
    const width = Math.max(40, Math.min(process.stdout.columns || 100, 140));
    const rule = "─".repeat(width - 2);
    const elapsed = Math.floor((Date.now() - sceneAt) / 1000);
    const body = scene.lines.map((line) => line.replace("{t}", String(elapsed)));
    if (scene.working) {
      const every = scene.streamEveryMs ?? 4_000;
      const shown = Math.min(scene.stream?.length ?? 0, Math.floor((Date.now() - sceneAt) / every));
      body.push(...(scene.stream ?? []).slice(0, shown));
      const glyph = "✻✶✢✳✽"[Math.floor(Date.now() / 500) % 5];
      body.push("", `${glyph} ${scene.spinner ?? "Working"}… (${elapsed}s · esc to interrupt)`);
    }
    const box =
      scene.box === false
        ? []
        : ["", rule, `❯ ${draft}`, rule, "  ⏵⏵ accept edits on (shift+tab to cycle)"];
    return `${ESC}[H${ESC}[2J${[...body, ...box].join("\r\n")}`;
  }

  function draw(): void {
    write(frame());
  }

  function readScene(): void {
    let text: string;
    try {
      text = fs.readFileSync(sceneFile, "utf8");
    } catch {
      return;
    }
    if (text === sceneText) return;
    sceneText = text;
    try {
      scene = JSON.parse(text) as FakeCanopyScene;
    } catch {
      return;
    }
    sceneAt = Date.now();
    draw();
  }

  setInterval(() => {
    readScene();
    if (scene.working) {
      write(OSC_WORKING);
      draw();
    } else if (wasWorking) {
      write(OSC_IDLE);
    }
    wasWorking = scene.working === true;
  }, 500);

  process.stdin.on("data", (chunk: Buffer) => {
    try {
      fs.appendFileSync(`${sceneFile}.keys`, chunk.toString("utf8"));
    } catch {
      // The key log is for the spec; the screen is what matters.
    }
    for (const ch of chunk.toString("utf8")) {
      if (ch === "\u0003") {
        write(`${ESC}[2J${ESC}[H`);
        process.exit(0);
      }
      if (ch === "\u007f" || ch === "\b") draft = draft.slice(0, -1);
      else if (ch === "\r" || ch === "\n") draft = "";
      else if (ch >= " " && ch !== "\u001b") draft += ch;
    }
    try {
      fs.writeFileSync(`${sceneFile}.draft`, draft);
    } catch {
      // The draft file is for the spec; the screen is what matters.
    }
    draw();
  });

  readScene();
  draw();
}

/** Installs the fake as `claude` in a bin dir under `repoDir`; returns the bin dir. */
export function installFakeCanopyAgent(repoDir: string, version = "9.9.9"): string {
  const binDir = path.join(repoDir, ".e2e canopy bin");
  const dir = path.join(binDir, "scenes");
  mkdirSync(dir, { recursive: true });
  const config: Config = { dir, version };
  const impl = path.join(binDir, "claude");
  writeFileSync(
    impl,
    [
      "#!/usr/bin/env node",
      `(${fakeCanopyProgram.toString()})(${JSON.stringify(config)}, require("fs"), require("path"));`,
      "",
    ].join("\n")
  );
  chmodSync(impl, 0o755);
  return binDir;
}

/** What the user has typed into pane `paneId`'s input box so far. */
export function readFakeCanopyDraft(binDir: string, paneId: string): string {
  try {
    return readFileSync(path.join(binDir, "scenes", `${paneId}.json.draft`), "utf8");
  } catch {
    return "";
  }
}

/** Everything pane `paneId`'s agent has received on its input, in order. */
export function readFakeCanopyKeys(binDir: string, paneId: string): string {
  try {
    return readFileSync(path.join(binDir, "scenes", `${paneId}.json.keys`), "utf8");
  } catch {
    return "";
  }
}

/** Shows `scene` in the fake agent running in pane `paneId`. */
export function setFakeCanopyScene(binDir: string, paneId: string, scene: FakeCanopyScene): void {
  writeFileSync(path.join(binDir, "scenes", `${paneId}.json`), JSON.stringify(scene));
}
