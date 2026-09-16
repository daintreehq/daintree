import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createMockHost } from "../../../../../shared/testing/createMockHost.js";
import type {
  PluginChannelSchema,
  PluginFsApi,
  PluginHostApi,
  PluginIpcContext,
  PluginIpcHandler,
} from "../../../../../shared/types/plugin.js";
import { PLUGIN_ID } from "../../shared/protocol.js";

/**
 * A mock host whose `fs` is a real temp directory. Handlers are invoked through
 * their registered schemas — args parsed on the way in, results parsed on the
 * way out — so a handler returning a shape the frozen protocol rejects fails
 * here exactly as it would at the host boundary.
 *
 * `writeFile` reproduces the host's checked-write contract (sha256 compare,
 * `REVISION_MISMATCH` with `currentRevision`) and the fs methods refuse any
 * path outside the worktree the way `scopes.fs.allowedPaths` does. The host's
 * own tests prove the real implementation; this proves the plugin honours it.
 */

const FIXTURES = path.join(import.meta.dirname, "..", "..", "__fixtures__");

export const sha = (data: Uint8Array | string): string =>
  createHash("sha256")
    .update(typeof data === "string" ? Buffer.from(data, "utf8") : data)
    .digest("hex");

function fsError(code: string, message: string): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

export interface Sandbox {
  root: string;
  worktree: string;
  appRoot: string;
  /** App-relative path → absolute path of each copied fixture component. */
  file(appRelative: string): string;
  cleanup(): Promise<void>;
}

/**
 * A monorepo worktree: the SvelteKit app lives at `apps/site`, a shared UI
 * package sits beside it, and the toolchain is hoisted to the root. That is
 * the layout where "relative to the Vite root" and "relative to the worktree"
 * differ, which is the case path handling has to get right.
 */
export async function createSandbox(): Promise<Sandbox> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "site-builder-main-")));
  const worktree = path.join(root, "worktree");
  const appRoot = path.join(worktree, "apps", "site");

  const write = async (target: string, contents: string) => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  };

  await write(path.join(worktree, "package.json"), JSON.stringify({ name: "mono", private: true }));
  await write(
    path.join(appRoot, "package.json"),
    await fs.readFile(path.join(FIXTURES, "projects", "plain", "package.json"), "utf8")
  );
  for (const pkg of ["svelte", "vite", "tailwindcss", "@sveltejs/kit"]) {
    await write(
      path.join(worktree, "node_modules", pkg, "package.json"),
      await fs.readFile(
        path.join(FIXTURES, "projects", "plain", "__node_modules__", pkg, "package.json"),
        "utf8"
      )
    );
  }
  for (const name of [
    "native.svelte",
    "invocations.svelte",
    "card.svelte",
    "dynamic-classes.svelte",
  ]) {
    await write(
      path.join(appRoot, "src", "lib", name),
      await fs.readFile(path.join(FIXTURES, "svelte", name), "utf8")
    );
  }
  await write(path.join(appRoot, "src", "routes", "+page.svelte"), "<h1>Home</h1>\n");
  await write(
    path.join(appRoot, ".svelte-kit", "generated", "root.svelte"),
    '<div id="svelte-announcer">x</div>\n'
  );
  await write(
    path.join(worktree, "packages", "ui", "Button.svelte"),
    '<button class="p-2">Go</button>\n'
  );
  await write(path.join(root, "outside.svelte"), '<p class="secret">outside</p>\n');

  return {
    root,
    worktree,
    appRoot,
    file: (appRelative) => path.join(appRoot, ...appRelative.split("/")),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

export interface TestHost {
  host: PluginHostApi;
  invoke<T = unknown>(channel: string, args: unknown): Promise<T>;
  channels(): string[];
  reads: string[];
  writes: Array<{ path: string; contents: string }>;
  watchers: Array<{ paths: string[]; callback: (changed: string) => void }>;
  pushes(): Array<{ channel: string; payload: unknown }>;
}

export function createTestHost(allowedRoot: string): TestHost {
  const mock = createMockHost({ pluginId: PLUGIN_ID });
  const schemas = new Map<string, PluginChannelSchema<unknown, unknown>>();
  const handlers = new Map<string, PluginIpcHandler>();
  const reads: string[] = [];
  const writes: Array<{ path: string; contents: string }> = [];
  const watchers: Array<{ paths: string[]; callback: (changed: string) => void }> = [];

  const contain = (target: string): string => {
    const resolved = path.resolve(target);
    const relative = path.relative(allowedRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`PATH_NOT_ALLOWED: ${target}`);
    }
    return resolved;
  };

  const diskFs: PluginFsApi = {
    readFile: async (target) => {
      reads.push(target);
      return fs.readFile(contain(target), "utf8");
    },
    readFileBytes: async (target) => {
      reads.push(target);
      return new Uint8Array(await fs.readFile(contain(target)));
    },
    writeFile: async (target, contents, options) => {
      const resolved = contain(target);
      if (options !== undefined && typeof options.expectedRevision === "string") {
        const current = await fs.readFile(resolved).catch(() => null);
        if (current === null) throw fsError("TARGET_UNAVAILABLE", "gone");
        const currentRevision = sha(current);
        if (currentRevision !== options.expectedRevision) {
          const error = fsError("REVISION_MISMATCH", "changed") as Error & {
            code: string;
            currentRevision: string;
          };
          error.currentRevision = currentRevision;
          throw error;
        }
      }
      writes.push({ path: resolved, contents });
      await fs.writeFile(resolved, contents, "utf8");
      return { revision: sha(contents) };
    },
    readdir: async (target) => {
      reads.push(target);
      const entries = await fs.readdir(contain(target), { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymbolicLink: entry.isSymbolicLink(),
      }));
    },
    stat: async (target) => {
      reads.push(target);
      const stat = await fs.stat(contain(target));
      return {
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        isSymbolicLink: stat.isSymbolicLink(),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    },
    watch: async (paths, callback) => {
      paths.forEach(contain);
      const record = { paths, callback };
      watchers.push(record);
      return () => {
        const index = watchers.indexOf(record);
        if (index !== -1) watchers.splice(index, 1);
      };
    },
  };

  const registerHandler = ((
    channel: string,
    schema: PluginChannelSchema<unknown, unknown>,
    handler: PluginIpcHandler
  ) => {
    schemas.set(channel, schema);
    handlers.set(channel, handler);
    return mock.registerHandler(channel, schema, handler as never);
  }) as PluginHostApi["registerHandler"];

  const host = Object.assign(Object.create(mock) as PluginHostApi, {
    fs: diskFs,
    registerHandler,
  });

  const ctx: PluginIpcContext = {
    projectId: "p1",
    worktreeId: "w1",
    webContentsId: 1,
    pluginId: PLUGIN_ID,
  };

  return {
    host,
    reads,
    writes,
    watchers,
    channels: () => [...handlers.keys()],
    pushes: () => mock.postToPanelCalls.map(({ channel, payload }) => ({ channel, payload })),
    async invoke<T>(channel: string, args: unknown): Promise<T> {
      const schema = schemas.get(channel);
      const handler = handlers.get(channel);
      if (!schema || !handler) throw new Error(`no handler for ${channel}`);
      const result = await handler(ctx, schema.args.parse(args));
      return schema.result.parse(result) as T;
    },
  };
}
