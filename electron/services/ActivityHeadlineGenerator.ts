import type { TerminalActivityStatus, TerminalTaskType } from "../../shared/types/terminal.js";
import type { AgentState, TerminalType } from "../../shared/types/domain.js";

export interface ActivityContext {
  terminalId: string;
  terminalType?: TerminalType;
  agentId?: string;
  agentState?: AgentState;
  lastCommand?: string;
  activity?: "busy" | "idle";
}

export interface GeneratedActivity {
  headline: string;
  status: TerminalActivityStatus;
  type: TerminalTaskType;
}

const COMMAND_PATTERNS: Array<{ pattern: RegExp; headline: string }> = [
  {
    pattern: /^npm\s+install|^npm\s+i\b|^yarn\s+install|^yarn\s*$|^pnpm\s+install|^bun\s+install/i,
    headline: "Installing dependencies",
  },
  {
    pattern: /^npm\s+test|^yarn\s+test|^pnpm\s+test|^jest|^vitest|^mocha/i,
    headline: "Running tests",
  },
  {
    pattern: /^npm\s+run\s+build|^yarn\s+build|^pnpm\s+build|^vite\s+build|^webpack/i,
    headline: "Building project",
  },
  { pattern: /^npm\s+run\s+dev|^yarn\s+dev|^pnpm\s+dev|^vite/i, headline: "Starting dev server" },
  { pattern: /^npm\s+run\s+lint|^eslint|^prettier/i, headline: "Running linter" },
  { pattern: /^git\s+clone/i, headline: "Cloning repository" },
  { pattern: /^git\s+push/i, headline: "Pushing changes" },
  { pattern: /^git\s+pull/i, headline: "Pulling changes" },
  { pattern: /^git\s+fetch/i, headline: "Fetching updates" },
  { pattern: /^git\s+checkout|^git\s+switch/i, headline: "Switching branch" },
  { pattern: /^git\s+merge/i, headline: "Merging changes" },
  { pattern: /^git\s+rebase/i, headline: "Rebasing branch" },
  { pattern: /^docker\s+build/i, headline: "Building image" },
  { pattern: /^docker\s+pull/i, headline: "Pulling image" },
  { pattern: /^docker\s+run|^docker-compose\s+up/i, headline: "Running container" },
  { pattern: /^cargo\s+build/i, headline: "Compiling Rust" },
  { pattern: /^cargo\s+test/i, headline: "Running Rust tests" },
  { pattern: /^go\s+build/i, headline: "Building Go" },
  { pattern: /^go\s+test/i, headline: "Running Go tests" },
  { pattern: /^pip\s+install|^poetry\s+install/i, headline: "Installing packages" },
  { pattern: /^python|^python3/i, headline: "Running Python" },
  { pattern: /^node\s+/i, headline: "Running Node.js" },
  { pattern: /^tsc\b/i, headline: "Type checking" },
  { pattern: /^make\b/i, headline: "Running make" },
  { pattern: /^curl\s+|^wget\s+/i, headline: "Downloading" },
];

export class ActivityHeadlineGenerator {
  private static readonly WRAPPER_COMMANDS = new Set([
    "time",
    "command",
    "nohup",
    "npx",
    "pnpx",
    "bunx",
  ]);
  private static readonly SUDO_VALUE_FLAGS = new Set(["-u", "-g", "-h", "-p", "-r", "-t", "-C"]);
  private static readonly WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
    npx: new Set(["-p", "--package", "-c", "--call"]),
    pnpx: new Set(["-p", "--package", "-c", "--call"]),
    time: new Set(["-o"]),
  };

  generate(context: ActivityContext): GeneratedActivity {
    // Agent terminals use agent state
    if (context.agentId) {
      return this.generateFromAgentState(context.agentState);
    }

    // Shell terminals use activity + command detection
    return this.generateFromShellActivity(context);
  }

  private generateFromAgentState(agentState?: AgentState): GeneratedActivity {
    switch (agentState) {
      case "working":
        return {
          headline: "Agent working",
          status: "working",
          type: "interactive",
        };
      case "waiting":
        return {
          headline: "Waiting for input",
          status: "waiting",
          type: "interactive",
        };
      case "completed":
        return {
          headline: "Completed",
          status: "success",
          type: "idle",
        };
      case "failed":
        return {
          headline: "Failed",
          status: "failure",
          type: "idle",
        };
      case "idle":
      default:
        return {
          headline: "Idle",
          status: "success",
          type: "idle",
        };
    }
  }

  private generateFromShellActivity(context: ActivityContext): GeneratedActivity {
    const { activity, lastCommand } = context;

    if (activity === "busy") {
      const headline = lastCommand ? this.getCommandHeadline(lastCommand) : "Command running";

      return {
        headline,
        status: "working",
        type: "background",
      };
    }

    return {
      headline: "Idle",
      status: "success",
      type: "idle",
    };
  }

  private isEnvAssignmentToken(token: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
  }

  private stripLeadingWrappers(command: string): string {
    const tokens = command.trim().split(/\s+/).filter(Boolean);
    let index = 0;

    while (index < tokens.length) {
      const token = tokens[index];
      const lower = token.toLowerCase();

      if (this.isEnvAssignmentToken(token)) {
        index += 1;
        continue;
      }

      if (lower === "sudo") {
        index += 1;
        while (index < tokens.length) {
          const option = tokens[index];
          if (option === "--") {
            index += 1;
            break;
          }
          if (!option.startsWith("-")) {
            break;
          }
          index += 1;
          if (ActivityHeadlineGenerator.SUDO_VALUE_FLAGS.has(option) && index < tokens.length) {
            index += 1;
          }
        }
        continue;
      }

      if (lower === "env") {
        index += 1;
        while (index < tokens.length) {
          const option = tokens[index];
          if (option === "--") {
            index += 1;
            break;
          }
          if (this.isEnvAssignmentToken(option)) {
            index += 1;
            continue;
          }
          if (!option.startsWith("-")) {
            break;
          }
          index += 1;
          if (option === "-u" && index < tokens.length) {
            index += 1;
          }
        }
        continue;
      }

      if (ActivityHeadlineGenerator.WRAPPER_COMMANDS.has(lower)) {
        index += 1;
        index = this.skipWrapperOptions(tokens, index, lower);
        continue;
      }

      break;
    }

    return tokens.slice(index).join(" ").trim();
  }

  private skipWrapperOptions(tokens: string[], index: number, wrapper: string): number {
    const valueFlags = ActivityHeadlineGenerator.WRAPPER_VALUE_FLAGS[wrapper] ?? new Set<string>();

    while (index < tokens.length) {
      const option = tokens[index];
      if (option === "--") {
        return index + 1;
      }
      if (!option.startsWith("-") || option === "-") {
        return index;
      }

      index += 1;

      const normalizedOption = option.split("=")[0];
      const takesValue =
        valueFlags.has(normalizedOption) && !option.includes("=") && index < tokens.length;
      if (takesValue) {
        index += 1;
      }
    }

    return index;
  }

  private getCommandHeadline(command: string): string {
    const trimmedCommand = command.trim();
    const normalizedCommand = this.stripLeadingWrappers(trimmedCommand) || trimmedCommand;

    for (const { pattern, headline } of COMMAND_PATTERNS) {
      if (pattern.test(normalizedCommand)) {
        return headline;
      }
    }

    // Generic fallback: extract the base command
    const parts = normalizedCommand.split(/\s+/);
    const baseCommand = parts[0]?.replace(/^\.\//, "") || "command";

    const capitalizedCommand = baseCommand.charAt(0).toUpperCase() + baseCommand.slice(1);

    return `Running ${capitalizedCommand}`;
  }
}
