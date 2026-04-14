import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CanopyCommand,
  CommandContext,
  CommandResult,
} from "../../../shared/types/commands.js";

const projectStoreMock = vi.hoisted(() => ({
  getProjectSettings:
    vi.fn<(projectId: string) => Promise<{ commandOverrides?: Array<Record<string, unknown>> }>>(),
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createCommand(
  overrides: Partial<CanopyCommand<Record<string, unknown>, string>> = {}
): CanopyCommand<Record<string, unknown>, string> {
  return {
    id: "project:test",
    label: "Test Command",
    description: "command",
    category: "project",
    execute: vi.fn(async () => ({ success: true, data: "ok" })),
    ...overrides,
  };
}

describe("CommandService adversarial", () => {
  let commandService: (typeof import("../CommandService.js"))["commandService"];
  const context: CommandContext = { projectId: "project-1" };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    projectStoreMock.getProjectSettings.mockResolvedValue({});
    ({ commandService } = await import("../CommandService.js"));
    commandService.clear();
  });

  afterEach(() => {
    commandService.clear();
    vi.restoreAllMocks();
    delete process.env.NODE_ENV;
  });

  it("lets an in-flight execution finish even if the registry is cleared mid-call", async () => {
    const execution = deferred<CommandResult<string>>();
    const command = createCommand({
      execute: vi.fn(() => execution.promise),
    });
    commandService.register(command);

    const first = commandService.execute(command.id, {}, {});
    commandService.clear();
    execution.resolve({ success: true, data: "done" });

    await expect(first).resolves.toEqual({ success: true, data: "done" });
    await expect(commandService.execute(command.id, {}, {})).resolves.toMatchObject({
      success: false,
      error: { code: "COMMAND_NOT_FOUND" },
    });
  });

  it("ignores dangerous override keys and leaves Object.prototype untouched", async () => {
    projectStoreMock.getProjectSettings.mockResolvedValue({
      commandOverrides: [
        {
          commandId: "project:test",
          defaults: {
            __proto__: { polluted: true },
            constructor: "ignored",
            prototype: "ignored",
            name: "safe-name",
          },
        },
      ],
    });

    const executeSpy = vi.fn(async (_ctx: CommandContext, args: Record<string, unknown>) => ({
      success: true,
      data: String(args.name),
    }));
    commandService.register(
      createCommand({
        args: [{ name: "name", type: "string", description: "name", required: false }],
        execute: executeSpy,
      })
    );

    const pollutedBefore = Object.prototype.hasOwnProperty.call(Object.prototype, "polluted");
    const result = await commandService.execute(
      "project:test",
      context,
      JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
    );

    expect(pollutedBefore).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
    expect(result).toMatchObject({ success: true, data: "safe-name" });
    expect(executeSpy).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ name: "safe-name" })
    );
  });

  it("rejects invalid override defaults before execute is called", async () => {
    projectStoreMock.getProjectSettings.mockResolvedValue({
      commandOverrides: [
        {
          commandId: "project:test",
          defaults: {
            retries: "abc",
            force: "maybe",
          },
        },
      ],
    });

    const executeSpy = vi.fn();
    commandService.register(
      createCommand({
        args: [
          { name: "retries", type: "number", description: "retries", required: false },
          { name: "force", type: "boolean", description: "force", required: false },
        ],
        execute: executeSpy,
      })
    );

    const result = await commandService.execute("project:test", context, {});

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "INVALID_ARGUMENT_TYPE",
        details: { argument: "retries" },
      },
    });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("lists against a stable snapshot even if isEnabled mutates the registry", async () => {
    const selfRemoving = createCommand({
      id: "project:self-removing",
      isEnabled: () => {
        commandService.unregister("project:second");
        return true;
      },
    });
    const second = createCommand({
      id: "project:second",
    });

    commandService.register(selfRemoving);
    commandService.register(second);

    const manifest = await commandService.list();

    expect(manifest.map((entry) => entry.id)).toEqual(["project:second", "project:self-removing"]);
  });

  it("treats override load failures as per-call failures without poisoning concurrent callers", async () => {
    projectStoreMock.getProjectSettings
      .mockRejectedValueOnce(new Error("settings unavailable"))
      .mockResolvedValueOnce({
        commandOverrides: [
          {
            commandId: "project:test",
            disabled: true,
          },
        ],
      });

    commandService.register(createCommand());

    const [listResult, executeResult] = await Promise.all([
      commandService.list(context),
      commandService.execute("project:test", context, {}),
    ]);

    expect(listResult).toEqual([
      expect.objectContaining({
        id: "project:test",
        enabled: true,
      }),
    ]);
    expect(executeResult).toMatchObject({
      success: false,
      error: { code: "COMMAND_DISABLED" },
    });
  });

  it("only returns stack details for execution failures in development", async () => {
    const command = createCommand({
      execute: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    commandService.register(command);

    process.env.NODE_ENV = "development";
    const devResult = await commandService.execute("project:test", {}, {});

    process.env.NODE_ENV = "production";
    const prodResult = await commandService.execute("project:test", {}, {});

    expect(devResult).toMatchObject({
      success: false,
      error: {
        code: "EXECUTION_ERROR",
        details: { stack: expect.any(String) },
      },
    });
    expect(prodResult).toMatchObject({
      success: false,
      error: {
        code: "EXECUTION_ERROR",
      },
    });
    expect(prodResult.error?.details).toBeUndefined();
  });
});
