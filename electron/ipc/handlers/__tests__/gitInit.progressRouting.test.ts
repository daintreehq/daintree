import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const { windowMock, appViews, gitMock } = vi.hoisted(() => ({
  windowMock: vi.fn<(wc: unknown) => unknown>(() => null),
  appViews: [] as Array<{
    id: number;
    isDestroyed: () => boolean;
    send: (...a: unknown[]) => void;
  }>,
  gitMock: { init: vi.fn(async () => undefined) },
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: windowMock,
  getProjectForWebContents: vi.fn(() => null),
  getAppWebContents: vi.fn((win: { wc: unknown }) => win.wc),
  getAllAppWebContents: vi.fn(() => appViews),
  getWebContentsForProject: vi.fn(() => []),
  hasRegisteredProjectViews: vi.fn(() => false),
  isCachedViewWebContents: vi.fn(() => false),
}));

vi.mock("../../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(async () => gitMock),
}));

import { computeMissingTemplateEntries, registerGitInitHandlers } from "../projectCrud/gitInit.js";
import { getGitignoreTemplate } from "../projectCrud/gitignoreTemplates.js";
import {
  GITIGNORE_TEMPLATE_OPTIONS,
  DEFAULT_GITIGNORE_TEMPLATE_ID,
  isGitignoreTemplateId,
} from "../../../../shared/config/gitignoreTemplates.js";
import { CHANNELS } from "../../channels.js";
import { getIpcDispatcher } from "../../dispatcher.js";
import { getEndpointRegistry, _resetEndpointRegistryForTesting } from "../../endpointRegistry.js";
import type { ClientEndpoint, HostFrame } from "../../endpoint.js";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const OPTIONS = { createGitignore: false, createInitialCommit: false };

function remoteEndpoint(handle: number) {
  const send = vi.fn<(frame: HostFrame) => void>();
  const endpoint: ClientEndpoint = {
    endpointId: `remote:${handle}`,
    clientId: `client-${handle}`,
    projectId: null,
    kind: "remote-view",
    handle,
    send,
    request: vi.fn(),
    onClose: () => ({ dispose: () => undefined }),
    isClosed: () => false,
  };
  return { endpoint, send };
}

function progressStatuses(calls: unknown[][]): string[] {
  return calls.map((call) => (call[1] as { status: string }).status);
}

describe("project:init-git-guided progress routing", () => {
  let directoryPath: string;
  let cleanup: () => void;

  beforeEach(async () => {
    ipcHandlers.clear();
    appViews.length = 0;
    windowMock.mockReset().mockReturnValue(null);
    _resetEndpointRegistryForTesting();
    directoryPath = await mkdtemp(path.join(os.tmpdir(), "daintree-gitinit-"));
    cleanup = registerGitInitHandlers();
  });

  afterEach(async () => {
    cleanup();
    getIpcDispatcher().setInvokeEnveloper(null);
    await rm(directoryPath, { recursive: true, force: true });
  });

  it("replies to the sending window", async () => {
    const view = { id: 5, isDestroyed: () => false, send: vi.fn() };
    const other = { id: 6, isDestroyed: () => false, send: vi.fn() };
    appViews.push(view, other);
    windowMock.mockReturnValue({ wc: view, isDestroyed: () => false });

    const handler = ipcHandlers.get(CHANNELS.PROJECT_INIT_GIT_GUIDED) as Handler;
    await handler({ sender: { id: 5 } }, { directoryPath, ...OPTIONS });

    expect(progressStatuses(view.send.mock.calls)).toEqual(["start", "success", "success"]);
    expect(other.send).not.toHaveBeenCalled();
  });

  it("still broadcasts for a local sender whose window can't be resolved", async () => {
    const view = { id: 5, isDestroyed: () => false, send: vi.fn() };
    appViews.push(view);

    const handler = ipcHandlers.get(CHANNELS.PROJECT_INIT_GIT_GUIDED) as Handler;
    await handler({ sender: { id: 5 } }, { directoryPath, ...OPTIONS });

    expect(view.send).toHaveBeenCalledTimes(3);
    expect(view.send.mock.calls[0]![0]).toBe(CHANNELS.PROJECT_INIT_GIT_PROGRESS);
  });

  it("sends a remote caller's progress to that caller alone", async () => {
    const localView = { id: 5, isDestroyed: () => false, send: vi.fn() };
    appViews.push(localView);
    const caller = remoteEndpoint(-1);
    const bystander = remoteEndpoint(-2);
    getEndpointRegistry().add(caller.endpoint);
    getEndpointRegistry().add(bystander.endpoint);
    getIpcDispatcher().setInvokeEnveloper(async (_channel, _args, call) =>
      wrapSuccess(await call())
    );

    const envelope = await getIpcDispatcher().invokeForEndpoint(
      {
        endpoint: caller.endpoint,
        client: { clientId: "client--1", clientName: "b", platform: "darwin", kind: "remote" },
      },
      CHANNELS.PROJECT_INIT_GIT_GUIDED,
      [{ directoryPath, ...OPTIONS }]
    );

    expect(envelope).toMatchObject({ ok: true, data: { outcome: "success" } });
    expect(caller.send).toHaveBeenCalledTimes(3);
    expect(
      caller.send.mock.calls.every(
        ([frame]) => frame.channel === CHANNELS.PROJECT_INIT_GIT_PROGRESS
      )
    ).toBe(true);
    expect(bystander.send).not.toHaveBeenCalled();
    expect(localView.send).not.toHaveBeenCalled();
  });
});

const TEMPLATE_IDS = GITIGNORE_TEMPLATE_OPTIONS.map((option) => option.value);
const LANGUAGE_IDS = TEMPLATE_IDS.filter((id) => id !== "minimal" && id !== "none");

function activeLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function resolve(id: string): string {
  const content = getGitignoreTemplate(id);
  if (content === null) throw new Error(`Expected template "${id}" to resolve`);
  return content;
}

/**
 * Negations whose target sits inside a literally excluded parent directory.
 * Git refuses to descend into an excluded directory, so those lines are dead:
 * `dir/*` keeps the directory traversable, `dir/` and `dir` do not. Pruning is
 * not order-sensitive the way last-match-wins is, so a parent excluded anywhere
 * in the file counts — unless that parent is itself re-included.
 */
function unreachableNegations(lines: string[]): string[] {
  const dead: string[] = [];

  for (const line of lines) {
    if (!line.startsWith("!")) continue;
    const segments = line.slice(1).replace(/\/$/, "").split("/");

    for (let depth = 1; depth < segments.length; depth++) {
      const parent = segments.slice(0, depth).join("/");
      if (!parent) continue;

      const spellings = [parent, `${parent}/`];

      // Whether git descends is decided by the LAST rule literally naming the
      // parent, so a re-inclusion only helps if nothing excludes it again after.
      let excluded = false;
      for (const other of lines) {
        if (spellings.includes(other)) excluded = true;
        else if (other.startsWith("!") && spellings.includes(other.slice(1))) excluded = false;
      }

      if (excluded) {
        dead.push(line);
        break;
      }
    }
  }

  return dead;
}

describe("gitignore template registry", () => {
  it("exposes unique ids", () => {
    expect(new Set(TEMPLATE_IDS).size).toBe(TEMPLATE_IDS.length);
  });

  it("defaults to the first listed option", () => {
    expect(DEFAULT_GITIGNORE_TEMPLATE_ID).toBe(TEMPLATE_IDS[0]);
  });

  it("resolves content for every id except the opt-out one", () => {
    for (const id of TEMPLATE_IDS) {
      const content = getGitignoreTemplate(id);
      if (id === "none") {
        expect(content, `${id} should not produce a file`).toBeNull();
      } else {
        expect(content, `${id} should produce a file`).not.toBeNull();
      }
    }
  });

  it("recognises exactly the registered ids", () => {
    for (const id of TEMPLATE_IDS) {
      expect(isGitignoreTemplateId(id)).toBe(true);
    }
    expect(isGitignoreTemplateId("unknown")).toBe(false);
    expect(isGitignoreTemplateId(undefined)).toBe(false);
  });

  // Guards the `Object.hasOwn` lookup against regressing to `in`, which would
  // accept inherited prototype keys and resolve them to garbage content.
  it("does not treat inherited object properties as templates", () => {
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(isGitignoreTemplateId(key), `${key} is not a template`).toBe(false);
      expect(getGitignoreTemplate(key), `${key} should not resolve`).toBeNull();
    }
  });
});

describe("gitignore template composition", () => {
  // Anchored on the default rather than on "minimal" so that promoting a
  // language template to the default fails here instead of quietly redefining
  // what every other template is built on.
  it("layers every other template on top of the full default baseline", () => {
    const baseline = resolve(DEFAULT_GITIGNORE_TEMPLATE_ID);
    for (const id of LANGUAGE_IDS) {
      const content = resolve(id);
      expect(content.startsWith(`${baseline}\n`), `${id} should open with the baseline`).toBe(true);
    }
  });

  it("adds language-specific rules beyond the baseline", () => {
    const baseline = new Set(activeLines(resolve(DEFAULT_GITIGNORE_TEMPLATE_ID)));
    for (const id of LANGUAGE_IDS) {
      const added = activeLines(resolve(id)).filter((line) => !baseline.has(line));
      expect(added.length, `${id} should add rules the baseline lacks`).toBeGreaterThan(0);
    }
  });

  it("gives each language template distinct content", () => {
    const rendered = LANGUAGE_IDS.map((id) => resolve(id));
    expect(new Set(rendered).size).toBe(LANGUAGE_IDS.length);
  });

  it("ends every template with a single trailing newline", () => {
    for (const id of TEMPLATE_IDS.filter((candidate) => candidate !== "none")) {
      const content = resolve(id);
      expect(content.endsWith("\n"), `${id} should end with a newline`).toBe(true);
      expect(content.endsWith("\n\n"), `${id} should not end with a blank line`).toBe(false);
    }
  });
});

describe("gitignore pattern semantics", () => {
  // `*.key` also matches Apple Keynote documents, so a broad rule silently
  // swallows real files. Scoped rules like `/storage/*.key` are still fine.
  it("never ignores every .key file", () => {
    for (const id of TEMPLATE_IDS.filter((candidate) => candidate !== "none")) {
      expect(activeLines(resolve(id)), `${id} should not blanket-ignore .key`).not.toContain(
        "*.key"
      );
    }
  });

  it("never negates inside a literally excluded parent directory", () => {
    for (const id of TEMPLATE_IDS.filter((candidate) => candidate !== "none")) {
      expect(unreachableNegations(activeLines(resolve(id))), `${id} has dead negations`).toEqual(
        []
      );
    }
  });
});

describe("computeMissingTemplateEntries", () => {
  it("returns all template entries when existing file is empty", () => {
    const template = "# comment\n.env\nnode_modules/\n";
    const missing = computeMissingTemplateEntries("", template);
    expect(missing).toEqual([".env", "node_modules/"]);
  });

  it("returns an empty list when the existing file covers every entry", () => {
    const template = "# OS\n.DS_Store\n.env\n";
    const existing = "# my notes\n.env\nfoo/\n.DS_Store\n";
    expect(computeMissingTemplateEntries(existing, template)).toEqual([]);
  });

  it("ignores comments and blank lines on both sides", () => {
    const template = "# header\n\n.env\n\n.DS_Store\n";
    const existing = "\n\n# other\n.env\n";
    expect(computeMissingTemplateEntries(existing, template)).toEqual([".DS_Store"]);
  });

  it("normalizes CRLF line endings", () => {
    const template = ".env\r\n.DS_Store\r\n";
    const existing = ".env\r\n";
    expect(computeMissingTemplateEntries(existing, template)).toEqual([".DS_Store"]);
  });

  it("trims whitespace before comparing", () => {
    const template = ".env\n.DS_Store\n";
    const existing = "  .env  \n .DS_Store \n";
    expect(computeMissingTemplateEntries(existing, template)).toEqual([]);
  });

  it("never reports a negation as missing", () => {
    const template = ".env\n!.env.example\n.yarn/*\n!.yarn/patches\n";
    expect(computeMissingTemplateEntries("", template)).toEqual([".env", ".yarn/*"]);
  });

  it("ignores negations the existing file happens to carry", () => {
    const template = ".env\n.DS_Store\n";
    const existing = "!.env\n.DS_Store\n";
    expect(computeMissingTemplateEntries(existing, template)).toEqual([".env"]);
  });
});
