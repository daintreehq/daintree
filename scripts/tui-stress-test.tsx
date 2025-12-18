#!/usr/bin/env node
/**
 * TUI Stress Test for Terminal Flicker Issue (#800)
 *
 * Reproduces the exact Claude Code / Canopy flickering scenario:
 *
 * ROOT CAUSE (from Codex analysis):
 * When Ink renders an animation frame, it sends:
 *   1. CSI A (cursor up N lines)
 *   2. CSI J (erase from cursor to end of screen)
 *   3. New frame content
 *
 * If the erase sequence (CSI J) and redraw content don't arrive in the same
 * write batch to xterm.js, there's a visible frame where content below the
 * animation is erased but not yet redrawn - causing flicker.
 *
 * This test stresses that scenario with:
 * - Large MCP status blocks with glowing/pulsing dots (like Codex calls)
 * - Multiple concurrent animations (multiplies the effect)
 * - Lots of static content below that must be redrawn each frame
 * - Static history above that should NEVER flicker
 *
 * TODO: Remove this file once issue #800 is resolved.
 */

import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";
import Spinner from "ink-spinner";

// Simulated conversation history (like Claude Code's scrollback)
// This is a LOT of text to simulate real usage
const conversationHistory = `
\x1b[1m\x1b[36m╭─\x1b[0m \x1b[1muser\x1b[0m
\x1b[1m\x1b[36m│\x1b[0m Please can you ask Codex to do a full breakdown of what this project is.
\x1b[1m\x1b[36m│\x1b[0m You can give it some guidance, but overall, just tell it what this thing is.
\x1b[1m\x1b[36m╰─\x1b[0m

\x1b[1m\x1b[35m╭─\x1b[0m \x1b[1massistant\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m I'll ask Codex to analyze the Canopy Command Center project. Let me use the
\x1b[1m\x1b[35m│\x1b[0m Codex MCP to get a comprehensive breakdown.
\x1b[1m\x1b[35m│\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m \x1b[2m> Using Codex MCP with model gpt-5.1-codex-max\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m The project appears to be an Electron-based IDE for orchestrating AI coding
\x1b[1m\x1b[35m│\x1b[0m agents. Key features include:
\x1b[1m\x1b[35m│\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m 1. \x1b[1mIntegrated Terminals\x1b[0m - Multiple PTY instances with xterm.js rendering
\x1b[1m\x1b[35m│\x1b[0m 2. \x1b[1mWorktree Dashboard\x1b[0m - Git worktree management and visualization
\x1b[1m\x1b[35m│\x1b[0m 3. \x1b[1mAgent State Tracking\x1b[0m - Monitors Claude, Gemini, Codex activity
\x1b[1m\x1b[35m│\x1b[0m 4. \x1b[1mContext Injection\x1b[0m - CopyTree service for feeding context to agents
\x1b[1m\x1b[35m│\x1b[0m 5. \x1b[1mSession Transcripts\x1b[0m - Records and exports agent conversations
\x1b[1m\x1b[35m│\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m The architecture follows Electron's main/renderer split:
\x1b[1m\x1b[35m│\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m \x1b[38;5;245m┌──────────────────────────────────────────────────────────────────────────┐\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m \x1b[38;5;245m│\x1b[0m \x1b[38;5;81mMain Process\x1b[0m (electron/)                                               \x1b[38;5;245m│\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m \x1b[38;5;245m│\x1b[0m   - PtyManager: node-pty process management                             \x1b[38;5;245m│\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m \x1b[38;5;245m│\x1b[0m   - WorktreeService: Git operations and monitoring                      \x1b[38;5;245m│\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m \x1b[38;5;245m│\x1b[0m   - DevServerManager: Dev server lifecycle                              \x1b[38;5;245m│\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m \x1b[38;5;245m│\x1b[0m   - AgentStateMachine: Tracks agent states via output heuristics        \x1b[38;5;245m│\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m \x1b[38;5;245m├──────────────────────────────────────────────────────────────────────────┤\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m \x1b[38;5;245m│\x1b[0m \x1b[38;5;81mRenderer Process\x1b[0m (src/)                                                \x1b[38;5;245m│\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m \x1b[38;5;245m│\x1b[0m   - React 19 UI with Tailwind CSS v4                                   \x1b[38;5;245m│\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m \x1b[38;5;245m│\x1b[0m   - XtermAdapter: xterm.js integration with Canvas                     \x1b[38;5;245m│\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m \x1b[38;5;245m│\x1b[0m   - Zustand stores for state management                                \x1b[38;5;245m│\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m \x1b[38;5;245m│\x1b[0m   - IPC bridge via window.electron                                     \x1b[38;5;245m│\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m \x1b[38;5;245m└──────────────────────────────────────────────────────────────────────────┘\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m Let me get more details from Codex about the terminal rendering pipeline...
\x1b[1m\x1b[35m╰─\x1b[0m

\x1b[1m\x1b[36m╭─\x1b[0m \x1b[1muser\x1b[0m
\x1b[1m\x1b[36m│\x1b[0m Great, can you also analyze the flickering issue we're seeing?
\x1b[1m\x1b[36m╰─\x1b[0m

\x1b[1m\x1b[35m╭─\x1b[0m \x1b[1massistant\x1b[0m
\x1b[1m\x1b[35m│\x1b[0m I'll have Codex analyze the terminal flickering issue. This requires looking
\x1b[1m\x1b[35m│\x1b[0m at the rendering pipeline from PTY through to xterm.js.
\x1b[1m\x1b[35m╰─\x1b[0m
`.trim();

// Help text - check first before printing history
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
\x1b[1mTUI Stress Test for Terminal Flicker Issue (#800)\x1b[0m

\x1b[2mUsage:\x1b[0m npm run stress-test

\x1b[1mWhat this tests:\x1b[0m
Reproduces the exact Claude Code rendering pattern:
  - Lots of conversation history text above
  - Large MCP blocks with glowing/pulsing dots
  - Multiple concurrent animations
  - Full-width separator lines
  - Input prompt at the bottom

\x1b[1mRoot Cause:\x1b[0m
Even though only small dots change, Ink redraws everything from
the top of its render area. The CSI J erases ALL content below,
including the input prompt, which must be redrawn every frame.

\x1b[1mSuccess criteria:\x1b[0m
  - Conversation history (scrollback) stays stable
  - Input prompt and separator lines don't flash
  - Only the glowing dots should visibly animate

\x1b[2mPress Ctrl+C to stop. Runs indefinitely.\x1b[0m
`);
  process.exit(0);
}

// Print static history immediately (not part of Ink)
console.log(conversationHistory);
console.log("");

// Progress bar component
function ProgressBar({ percent, width = 20 }: { percent: number; width?: number }) {
  const filled = Math.floor((percent / 100) * width);
  const empty = width - filled;
  return (
    <Text>
      <Text color="green">{"█".repeat(filled)}</Text>
      <Text color="gray">{"░".repeat(empty)}</Text>
    </Text>
  );
}

// Glowing dot that pulses from dark to light (like Codex MCP status)
function GlowingDot({ frame, baseColor = "cyan" }: { frame: number; baseColor?: string }) {
  // Cycle through brightness levels to create a glow/pulse effect
  const brightness = Math.sin(frame * 0.15) * 0.5 + 0.5; // 0 to 1

  // Use different shades based on brightness
  if (brightness > 0.8) {
    return <Text color="whiteBright">●</Text>;
  } else if (brightness > 0.6) {
    return <Text color="cyanBright">●</Text>;
  } else if (brightness > 0.4) {
    return <Text color="cyan">●</Text>;
  } else if (brightness > 0.2) {
    return <Text color="blue">●</Text>;
  } else {
    return <Text color="blueBright">●</Text>;
  }
}

// Large MCP call block with glowing dot - simulates Codex MCP
function CodexMcpBlock({
  title,
  promptText,
  frame,
  taskOffset,
}: {
  title: string;
  promptText: string;
  frame: number;
  taskOffset: number;
}) {
  const elapsed = (frame * 0.08 + taskOffset * 0.5).toFixed(0);
  const tokens = 404 + frame * 3 + taskOffset * 200;

  const messages = ["Herding…", "Thinking…", "Processing…", "Analyzing…"];
  const msg = messages[Math.floor((frame + taskOffset) / 15) % messages.length];

  // Split prompt into multiple lines for realistic display
  const lines: string[] = [];
  let remaining = promptText;
  const lineWidth = 100;
  while (remaining.length > 0) {
    lines.push(remaining.slice(0, lineWidth));
    remaining = remaining.slice(lineWidth);
  }

  return (
    <Box flexDirection="column">
      {/* MCP call header */}
      <Box>
        <GlowingDot frame={frame + taskOffset} />
        <Text> </Text>
        <Text bold color="white">
          {title}
        </Text>
        <Text dimColor> - </Text>
        <Text>codex</Text>
        <Text dimColor> (MCP)</Text>
        <Text color="yellow">(</Text>
        <Text dimColor>prompt: "</Text>
      </Box>

      {/* Multi-line prompt text */}
      {lines.map((line, i) => (
        <Box key={i}>
          <Text dimColor> {line}</Text>
        </Box>
      ))}

      <Box>
        <Text dimColor>
          {" "}
          ", model: "gpt-5.1-codex-max", cwd: "/Users/dev/project", sandbox: "read-only"
        </Text>
        <Text color="yellow">)</Text>
      </Box>

      {/* Animated status line with spinner */}
      <Box marginTop={1}>
        <Text dimColor> · </Text>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text color="cyan"> {msg}</Text>
        <Text dimColor> (esc to interrupt · {elapsed}s · </Text>
        <Text color="gray">↓ </Text>
        <Text>{tokens}</Text>
        <Text dimColor> tokens)</Text>
      </Box>
    </Box>
  );
}

// Individual MCP-style task box with multiple animations
function McpTaskBox({
  title,
  color,
  frame,
  taskOffset,
}: {
  title: string;
  color: string;
  frame: number;
  taskOffset: number;
}) {
  const files = [
    "src/components/Terminal/XtermAdapter.tsx",
    "electron/services/pty/TerminalProcess.ts",
    "src/services/TerminalInstanceService.ts",
    "electron/services/WorktreeService.ts",
    "src/store/terminalStore.ts",
  ];

  const operations = ["Reading", "Analyzing", "Processing", "Checking", "Scanning"];
  const currentFile = files[(frame + taskOffset) % files.length];
  const currentOp = operations[Math.floor((frame + taskOffset) / 3) % operations.length];

  const todos = [
    { content: "Analyze codebase structure", done: frame > 10 + taskOffset },
    { content: "Identify optimization targets", done: frame > 25 + taskOffset },
    { content: "Generate recommendations", done: false },
  ];

  const elapsed = (frame * 0.08 + taskOffset * 0.5).toFixed(1);
  const tokens = (1247 + frame * 23 + taskOffset * 500) % 50000;
  const contextUsed = Math.min(95, 35 + frame * 0.15 + taskOffset * 10);

  const activityMsgs = [
    `Parsed ${currentFile.split("/").pop()}`,
    "Found optimization opportunity",
    "Analyzing dependencies",
    "Checking type safety",
  ];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      {/* Header with spinner */}
      <Box>
        <Text color={color}>
          <Spinner type="dots" />
        </Text>
        <Text bold color={color}>
          {" "}
          {title}
        </Text>
        <Text dimColor> • {elapsed}s • </Text>
        <Text color="yellow">{tokens.toLocaleString()}</Text>
        <Text dimColor> tokens</Text>
      </Box>

      {/* Current file being processed */}
      <Box marginTop={1}>
        <Text color="cyan">
          <Spinner type="dots12" />
        </Text>
        <Text> </Text>
        <Text color="yellow">{currentOp}</Text>
        <Text> </Text>
        <Text dimColor>{currentFile}</Text>
      </Box>

      {/* Todo list */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold dimColor>
          Tasks:
        </Text>
        {todos.map((todo, i) => (
          <Box key={i}>
            <Text> </Text>
            {todo.done ? (
              <Text color="green">✓</Text>
            ) : (
              <Text color="cyan">
                <Spinner type="dots" />
              </Text>
            )}
            <Text> </Text>
            <Text color={todo.done ? "green" : "white"} strikethrough={todo.done}>
              {todo.content}
            </Text>
          </Box>
        ))}
      </Box>

      {/* Progress indicators */}
      <Box marginTop={1}>
        <Text dimColor>Context: </Text>
        <Text>[</Text>
        <ProgressBar percent={contextUsed} width={20} />
        <Text>] </Text>
        <Text color={contextUsed > 80 ? "red" : contextUsed > 60 ? "yellow" : "green"}>
          {contextUsed.toFixed(0)}%
        </Text>
      </Box>

      {/* Activity log - each line has its own spinner */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold dimColor>
          Activity:
        </Text>
        {[0, 1, 2].map((i) => {
          const ts = new Date(Date.now() - (2 - i) * 800).toISOString().slice(11, 19);
          return (
            <Box key={i}>
              <Text dimColor> {ts} </Text>
              <Text color="cyan">
                <Spinner type="dots" />
              </Text>
              <Text> {activityMsgs[(frame + i + taskOffset) % activityMsgs.length]}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

// Main stress test component
function StressTest() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [frame, setFrame] = useState(0);
  const [inputText, setInputText] = useState("");
  const [cursorVisible, setCursorVisible] = useState(true);

  // Get terminal width for full-width separators
  const terminalWidth = stdout?.columns || 120;

  // Animation loop - 80ms interval (12.5 fps) to match typical TUI refresh
  // Runs indefinitely until user presses Ctrl+C
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => f + 1);
    }, 80);

    return () => {
      clearInterval(timer);
    };
  }, []);

  // Cursor blink (530ms is typical terminal cursor blink rate)
  useEffect(() => {
    const timer = setInterval(() => {
      setCursorVisible((v) => !v);
    }, 530);
    return () => clearInterval(timer);
  }, []);

  // Handle input
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
    } else if (key.backspace || key.delete) {
      setInputText((t) => t.slice(0, -1));
    } else if (key.return) {
      setInputText("");
    } else if (input && !key.ctrl && !key.meta) {
      setInputText((t) => t + input);
    }
  });

  // Full-width separator line
  const separatorLine = "─".repeat(terminalWidth);

  const codexPrompt1 =
    "Please do a comprehensive breakdown of this project - Canopy Command Center. Explore the codebase thoroughly and explain: 1. What is this project? - The core purpose and value proposition 2. Architecture overview - How the Electron main/renderer processes work together 3. Key features - What can users actually do with this tool? 4. Technical implementation - How are the major features built (terminals, worktrees, agent state tracking, etc.) 5. Target users - Who is this for and what problems does it solve? Look at the actual code structure, the services, the React components, and the IPC bridge to understand how everything fits together.";

  const codexPrompt2 =
    "Analyze the terminal rendering pipeline in this Electron app. Focus on: 1. How PTY output flows from node-pty through IPC to xterm.js 2. The SharedRingBuffer implementation for zero-copy I/O 3. Canvas renderer configuration 4. Output throttling and batching strategies 5. The flickering issue when TUI frameworks like Ink render animations. Identify the root cause and propose solutions.";

  return (
    <Box flexDirection="column">
      {/* Large Codex MCP blocks with glowing dots */}
      <CodexMcpBlock title="codex" promptText={codexPrompt1} frame={frame} taskOffset={0} />

      <Box marginTop={1}>
        <CodexMcpBlock title="codex" promptText={codexPrompt2} frame={frame} taskOffset={7} />
      </Box>

      {/* TWO parallel MCP task boxes with lots of animations */}
      <Box marginTop={1}>
        <McpTaskBox title="Codex Analysis #1" color="magenta" frame={frame} taskOffset={0} />
      </Box>

      <Box marginTop={1}>
        <McpTaskBox title="Codex Analysis #2" color="blue" frame={frame} taskOffset={5} />
      </Box>

      {/* System status bar with multiple spinners */}
      <Box marginTop={1} paddingX={1}>
        <Text color="green">
          <Spinner type="dots" />
        </Text>
        <Text> System </Text>
        <Text dimColor>CPU:</Text>
        <Text> {(45 + Math.sin(frame * 0.1) * 20) | 0}% </Text>
        <Text dimColor>MEM:</Text>
        <Text> {(55 + Math.sin(frame * 0.07) * 15) | 0}% </Text>
        <Text dimColor>Frame:</Text>
        <Text> {frame} </Text>
        <Text dimColor>({(frame * 0.08).toFixed(1)}s)</Text>
      </Box>

      {/* Full-width separator line - THIS SHOULD NOT FLICKER */}
      <Box marginTop={1}>
        <Text dimColor>{separatorLine}</Text>
      </Box>

      {/* Input prompt area - THIS SHOULD NOT FLICKER */}
      <Box>
        <Text dimColor>{">"}</Text>
        <Text> </Text>
        <Text>{inputText}</Text>
        <Text color="white">{cursorVisible ? "█" : " "}</Text>
      </Box>

      {/* Another full-width separator */}
      <Text dimColor>{separatorLine}</Text>

      {/* Status hint line - THIS SHOULD NOT FLICKER */}
      <Box>
        <Text> </Text>
        <Text color="cyan">{"⏵⏵"}</Text>
        <Text> bypass permissions on </Text>
        <Text dimColor>(shift+tab to cycle)</Text>
      </Box>
    </Box>
  );
}

// Use patchConsole to prevent any stray console.log from breaking the TUI
render(<StressTest />, { patchConsole: true });
