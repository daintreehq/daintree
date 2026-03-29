import path from "node:path";
import fs from "node:fs";
import { getAgentConfig } from "../../shared/config/agentRegistry.js";
import { buildPatternConfig } from "../../electron/services/pty/terminalActivityPatterns.js";
import {
  createPatternDetector,
  stripAnsi,
} from "../../electron/services/pty/AgentPatternDetector.js";
import { appendJsonLine, ensureDir } from "../perf/lib/io.js";
import type { CorpusEntry, AgentState } from "./types.js";

interface RunnerOptions {
  agentId: string;
  outDir: string;
  timeoutMs: number;
  prompts: string[];
}

const DEFAULT_PROMPTS = [
  "Write a hello world function in TypeScript",
  "Now add error handling to it",
];

const DEFAULT_TIMEOUT_MS = 120_000;

const SUPPORTED_AGENTS = ["claude", "gemini", "codex", "opencode"];

function parseArgs(argv: string[]): RunnerOptions {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.replace(/^--/, "");
    const value = argv[i + 1];
    if (value && !value.startsWith("--")) {
      args.set(key, value);
      i++;
    }
  }

  const agentId = args.get("agent");
  if (!agentId || !SUPPORTED_AGENTS.includes(agentId)) {
    throw new Error(`--agent required. Supported: ${SUPPORTED_AGENTS.join(", ")}`);
  }

  return {
    agentId,
    outDir: args.get("out") ?? path.resolve(process.cwd(), ".tmp/corpus"),
    timeoutMs: Number(args.get("timeout") ?? DEFAULT_TIMEOUT_MS),
    prompts: DEFAULT_PROMPTS,
  };
}

async function runSession(options: RunnerOptions): Promise<string> {
  // Dynamic import: node-pty is a native module that may need rebuild for Node.js context
  let pty: typeof import("node-pty");
  try {
    pty = await import("node-pty");
  } catch {
    throw new Error(
      "Failed to import node-pty. In CI, run: npx electron-rebuild -f -w node-pty --runtime node"
    );
  }

  const agentConfig = getAgentConfig(options.agentId);
  if (!agentConfig) {
    throw new Error(`Unknown agent: ${options.agentId}`);
  }

  const detection = agentConfig.detection;
  const patternConfig = detection ? buildPatternConfig(detection, options.agentId) : undefined;
  const detector = createPatternDetector(options.agentId, patternConfig ?? undefined);

  ensureDir(options.outDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const corpusPath = path.join(options.outDir, `${options.agentId}_${timestamp}.jsonl`);

  const startTime = Date.now();
  const entries: CorpusEntry[] = [];

  const ptyProcess = pty.spawn(agentConfig.command, agentConfig.args ?? [], {
    name: "xterm-256color",
    cols: 80,
    rows: 30,
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(agentConfig.env ?? {}),
    } as Record<string, string>,
  });

  let promptIndex = 0;
  let lastOutputTime = Date.now();
  let bootDetected = false;

  const recordChunk = (data: string) => {
    const time = (Date.now() - startTime) / 1000;
    const result = detector.detect(data);

    let state: AgentState = "unknown";
    if (result.isWorking) {
      state = "working";
    } else {
      const clean = stripAnsi(data);
      if (!bootDetected) {
        state = "initializing";
      } else if (clean.trim().length < 10) {
        state = "waiting";
      }
    }

    const entry: CorpusEntry = {
      time: Math.round(time * 100) / 100,
      chunk: data,
      detectedState: state,
      confidence: result.confidence,
      agentId: options.agentId,
    };

    entries.push(entry);
    appendJsonLine(corpusPath, entry);
    lastOutputTime = Date.now();
  };

  ptyProcess.onData(recordChunk);

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.log(`[runner] Timeout reached (${options.timeoutMs}ms), killing process`);
      ptyProcess.kill();
    }, options.timeoutMs);

    const promptInterval = setInterval(() => {
      const silenceMs = Date.now() - lastOutputTime;

      if (!bootDetected && silenceMs > 3000 && entries.length > 0) {
        bootDetected = true;
        console.log(`[runner] Boot detected after ${entries.length} chunks`);
      }

      if (bootDetected && silenceMs > 2000 && promptIndex < options.prompts.length) {
        const prompt = options.prompts[promptIndex];
        console.log(`[runner] Sending prompt ${promptIndex + 1}: "${prompt}"`);
        ptyProcess.write(prompt + "\r");
        promptIndex++;
      }

      if (promptIndex >= options.prompts.length && silenceMs > 5000 && bootDetected) {
        console.log("[runner] All prompts sent, sending quit command");
        const quitCmd = agentConfig.shutdown?.quitCommand ?? "/quit";
        ptyProcess.write(quitCmd + "\r");
        clearInterval(promptInterval);
      }
    }, 1000);

    ptyProcess.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      clearInterval(promptInterval);
      console.log(
        `[runner] Process exited (code=${exitCode}), captured ${entries.length} chunks → ${corpusPath}`
      );
      resolve(corpusPath);
    });
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.log(`[runner] Starting session for ${options.agentId}`);
  console.log(`[runner] Output: ${options.outDir}`);
  console.log(`[runner] Timeout: ${options.timeoutMs}ms`);

  try {
    const corpusPath = await runSession(options);
    console.log(`[runner] Session complete: ${corpusPath}`);
  } catch (error) {
    console.error("[runner] Session failed:", error);
    process.exitCode = 1;
  }
}

main();
