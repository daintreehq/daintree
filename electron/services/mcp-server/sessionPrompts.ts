import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import type { PromptDefinition, PromptRenderContext } from "./shared.js";
import { PROMPT_DEFINITIONS, PROMPT_TERMINAL_OUTPUT_MAX_CHARS } from "./shared.js";
import type { SessionContext } from "./sessionContext.js";
import { sessionGoneError } from "./sessionRouteErrors.js";
import type { SessionServerDeps } from "./sessionServerDepsContract.js";

export function registerPromptHandlers(
  server: Server,
  session: SessionContext,
  deps: Pick<SessionServerDeps, "sessionStore" | "dispatchAction">
): void {
  const { sessionId, mayNameTerminal } = session;
  const { sessionStore, dispatchAction } = deps;

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    if (sessionStore.getTier(sessionId) === null) throw sessionGoneError();
    return {
      prompts: PROMPT_DEFINITIONS.map((def) => ({
        name: def.name,
        description: def.description,
        arguments: def.arguments,
      })),
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    // Prompts render from live IDE state: `collectPromptContext` dispatches
    // `worktree.getCurrent`, and `triage_failed_agent` also reads terminal
    // output. That is a renderer dispatch on behalf of the session, so it
    // belongs behind the same liveness gate as `tools/call` — otherwise a
    // revoked bearer still reads worktree and terminal data through the prompt
    // surface, which is the leak this issue is about wearing a different hat.
    const promptTier = sessionStore.getTier(sessionId);
    if (promptTier === null) throw sessionGoneError();
    const name = request.params.name;
    const definition = PROMPT_DEFINITIONS.find((def) => def.name === name);
    if (!definition) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
    }

    const rawArgs = request.params.arguments ?? {};

    if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
      throw new McpError(ErrorCode.InvalidParams, "Prompt arguments must be an object");
    }

    for (const [key, value] of Object.entries(rawArgs)) {
      if (typeof value !== "string") {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Prompt argument '${key}' must be a string, got ${typeof value}`
        );
      }
    }

    const args = rawArgs as Record<string, string>;

    for (const arg of definition.arguments) {
      if (arg.required && !args[arg.name]?.trim()) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Missing required argument for prompt '${name}': ${arg.name}`
        );
      }
    }

    // An assistant's output goes only to an assistant that may reach it (#13496).
    const namedTerminal = args.terminal_id?.trim();
    const context = await collectPromptContext(
      definition,
      namedTerminal && !mayNameTerminal(promptTier, namedTerminal)
        ? { ...args, terminal_id: "" }
        : args,
      dispatchAction
    );
    const text = definition.render(args, context);

    return {
      description: definition.description,
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text },
        },
      ],
    };
  });
}

async function collectPromptContext(
  definition: PromptDefinition,
  args: Record<string, string>,
  dispatchAction: SessionServerDeps["dispatchAction"]
): Promise<PromptRenderContext> {
  const context: PromptRenderContext = {};

  // triage_terminals is a static recipe — render() ignores context, so skip
  // the worktree dispatch to avoid a 30s safeDispatch timeout penalty when the
  // renderer is unavailable (startup, view teardown, project switch).
  if (definition.name !== "triage_terminals") {
    const worktree = await safeDispatch("worktree.getCurrent", undefined, dispatchAction);
    if (worktree && typeof worktree === "object") {
      const w = worktree as Record<string, unknown>;
      if (typeof w.path === "string") context.worktreePath = w.path;
      if (typeof w.branch === "string") context.worktreeBranch = w.branch;
      if (typeof w.issueNumber === "number") context.worktreeIssueNumber = w.issueNumber;
    }
  }

  if (definition.name === "triage_failed_agent") {
    const terminalId = args.terminal_id?.trim();
    if (terminalId) {
      const result = await safeDispatch(
        "terminal.getOutput",
        {
          terminalId,
          maxLines: 100,
          stripAnsi: true,
        },
        dispatchAction
      );
      if (result && typeof result === "object") {
        const r = result as Record<string, unknown>;
        if (typeof r.content === "string") {
          const content = r.content;
          if (content.length > PROMPT_TERMINAL_OUTPUT_MAX_CHARS) {
            const tail = content.slice(-PROMPT_TERMINAL_OUTPUT_MAX_CHARS);
            context.terminalOutput = `… [truncated to last ${PROMPT_TERMINAL_OUTPUT_MAX_CHARS} chars]\n${tail}`;
          } else {
            context.terminalOutput = content;
          }
        }
      }
    }
  }

  return context;
}

async function safeDispatch(
  actionId: string,
  args: unknown,
  dispatchAction: SessionServerDeps["dispatchAction"]
): Promise<unknown> {
  try {
    const envelope = await dispatchAction(actionId, args);
    if (envelope.result.ok) {
      return envelope.result.result;
    }
    return null;
  } catch {
    return null;
  }
}
