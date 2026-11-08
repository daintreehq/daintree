import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const openWithDefaultApp = vi.hoisted(() => vi.fn<(target: string) => Promise<string>>());
const service = vi.hoisted(() => ({
  getUserPromptTemplatesDir: vi.fn(() => "/me/.daintree/templates"),
  ensureUserPromptTemplatesDir: vi.fn<(dir: string) => Promise<string>>(),
  readUserPromptTemplates: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
}));
vi.mock("../../../utils/openPath.js", () => ({ openWithDefaultApp }));
vi.mock("../../../services/userPromptTemplates.js", () => service);

import { registerUserPromptTemplatesHandlers } from "../userPromptTemplates.js";

const EVENT = {
  sender: { id: 1, isDestroyed: () => false },
  senderFrame: { url: "app://daintree/index.html" },
};

function call(channel: string) {
  return Promise.resolve(handlers.get(channel)!(EVENT));
}

describe("userPromptTemplates handlers", () => {
  let dispose: () => void;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    openWithDefaultApp.mockReset().mockResolvedValue("");
    service.ensureUserPromptTemplatesDir.mockReset().mockResolvedValue("/me/.daintree/templates");
    service.readUserPromptTemplates.mockReset();
    dispose = registerUserPromptTemplatesHandlers();
  });

  afterEach(() => {
    dispose();
    vi.restoreAllMocks();
  });

  it("answers a list with the folder as it stands", async () => {
    const snapshot = {
      directory: "/me/.daintree/templates",
      templates: [{ id: "t", title: "T", description: "D", body: "B", args: [] }],
      problems: [{ fileName: "bad.md", reason: "title is missing" }],
    };
    service.readUserPromptTemplates.mockResolvedValue(snapshot);
    await expect(call("user-prompt-templates:list")).resolves.toEqual(snapshot);
    expect(service.readUserPromptTemplates).toHaveBeenCalledTimes(1);
  });

  it("creates the folder before opening it, and says it opened", async () => {
    await expect(call("user-prompt-templates:open-folder")).resolves.toEqual({
      directory: "/me/.daintree/templates",
      opened: true,
    });
    expect(service.ensureUserPromptTemplatesDir.mock.invocationCallOrder[0]).toBeLessThan(
      openWithDefaultApp.mock.invocationCallOrder[0]!
    );
    expect(openWithDefaultApp).toHaveBeenCalledWith("/me/.daintree/templates");
  });

  it("says it didn't open when the OS opener refuses", async () => {
    openWithDefaultApp.mockResolvedValue("No application");
    await expect(call("user-prompt-templates:open-folder")).resolves.toEqual({
      directory: "/me/.daintree/templates",
      opened: false,
    });
  });

  it("doesn't try the opener on a folder it couldn't create", async () => {
    service.ensureUserPromptTemplatesDir.mockRejectedValue(new Error("EACCES"));
    await expect(call("user-prompt-templates:open-folder")).resolves.toEqual({
      directory: "/me/.daintree/templates",
      opened: false,
    });
    expect(openWithDefaultApp).not.toHaveBeenCalled();
  });
});
