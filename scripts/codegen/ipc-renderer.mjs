#!/usr/bin/env node
// Generates shared/types/ipc/generated-api.ts from the `*_METHOD_CHANNELS`
// constants exported by each `electron/ipc/handlers/*.preload.ts` file. The
// generated `GeneratedElectronAPI` interface is extended by the hand-
// maintained `ElectronAPI` in `shared/types/ipc/api.ts`, mirroring the
// `IpcInvokeMap extends GeneratedIpcInvokeMap` pattern in `maps.ts`.
//
// Usage:
//   node scripts/codegen/ipc-renderer.mjs            # write generated-api.ts
//   node scripts/codegen/ipc-renderer.mjs --check    # CI-only — exit 1 if stale
//
// Files declaring `export const RENDERER_API_SKIP = true` are excluded: those
// namespaces (currently only `demo`) have a renderer surface that diverges
// from the underlying IPC channel payload shape and must stay hand-written.
//
// Generation rule: each method is emitted as
//   <method>(...args: IpcInvokeMap[<channel>]["args"]): Promise<IpcInvokeMap[<channel>]["result"]>;
// so renderer call signatures track `IpcInvokeMap` automatically when the
// underlying contract changes.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..", "..");

const HANDLERS_DIR = path.join(REPO_ROOT, "electron", "ipc", "handlers");
const OUTPUT_PATH = path.join(REPO_ROOT, "shared", "types", "ipc", "generated-api.ts");

function defaultHandlerFiles() {
  return readdirSync(HANDLERS_DIR)
    .filter((name) => name.endsWith(".preload.ts"))
    .map((name) => path.join(HANDLERS_DIR, name));
}

export async function generateRendererApi({ handlerFiles = defaultHandlerFiles() } = {}) {
  const namespaces = new Map();
  const seenChannels = new Map();
  const seenMethods = new Map();

  for (const filePath of handlerFiles) {
    const source = readFileSync(filePath, "utf8");
    if (hasRendererApiSkip(source)) continue;

    const constants = extractMethodChannelConstants(source, filePath);
    for (const constant of constants) {
      const namespaceName = deriveNamespaceName(constant.entries, filePath, constant.name);

      let namespace = namespaces.get(namespaceName);
      if (!namespace) {
        namespace = { name: namespaceName, methods: [] };
        namespaces.set(namespaceName, namespace);
        seenMethods.set(namespaceName, new Map());
      }
      const namespaceMethods = seenMethods.get(namespaceName);

      for (const entry of constant.entries) {
        const prior = seenChannels.get(entry.channel);
        if (prior) {
          throw codegenError(
            `duplicate channel "${entry.channel}" registered in ${prior} and ${path.relative(REPO_ROOT, filePath)}`,
            filePath
          );
        }
        const priorMethod = namespaceMethods.get(entry.method);
        if (priorMethod) {
          throw codegenError(
            `namespace "${namespaceName}" already has method "${entry.method}" from ${priorMethod} — cannot redeclare in ${path.relative(REPO_ROOT, filePath)}`,
            filePath
          );
        }
        seenChannels.set(entry.channel, path.relative(REPO_ROOT, filePath));
        namespaceMethods.set(entry.method, path.relative(REPO_ROOT, filePath));
        namespace.methods.push(entry);
      }
    }
  }

  const sorted = [...namespaces.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const ns of sorted) {
    ns.methods.sort((a, b) => a.method.localeCompare(b.method));
  }
  return renderOutput(sorted);
}

function hasRendererApiSkip(source) {
  // Strip comments first so a documentation reference like
  // `// export const RENDERER_API_SKIP = true` in a JSDoc paragraph cannot
  // accidentally suppress the whole namespace.
  return /export\s+const\s+RENDERER_API_SKIP\s*=\s*true\b/.test(stripComments(source));
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// Pulls every `export const <NAME>_METHOD_CHANNELS = { ... } as const ...`
// block out of a preload source file. The capture is regex-based because
// every preload file in the repo follows the same shape (verified) and a
// dedicated AST pass via ts-morph would add a second TypeScript compile to
// the codegen step for no extra information.
function extractMethodChannelConstants(source, filePath) {
  const re =
    /export\s+const\s+([A-Z][A-Z0-9_]*_METHOD_CHANNELS)\s*=\s*\{([\s\S]*?)\}\s*as\s+const\b/g;
  const out = [];
  let match;
  while ((match = re.exec(source)) !== null) {
    const name = match[1];
    const body = match[2];
    const entries = parseChannelEntries(body, filePath, name);
    if (entries.length === 0) {
      throw codegenError(
        `${name} is empty — every preload constant must declare at least one method`,
        filePath
      );
    }
    out.push({ name, entries });
  }
  return out;
}

function parseChannelEntries(body, filePath, constantName) {
  const entries = [];
  // Strip both block and line comments so commented-out entries cannot
  // masquerade as live methods.
  const stripped = stripComments(body);
  // Match `method: "channel-string",` — channel strings have a colon prefix
  // (`namespace:verb-noun`) so we require it to avoid picking up unrelated
  // string properties.
  const entryRe = /([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*"([^"\n]+:[^"\n]+)"\s*,?/g;
  let match;
  while ((match = entryRe.exec(stripped)) !== null) {
    const method = match[1];
    const channel = match[2];
    if (entries.some((e) => e.method === method)) {
      throw codegenError(`${constantName} declares method "${method}" twice`, filePath);
    }
    entries.push({ method, channel });
  }
  return entries;
}

// Channel strings are `<namespace-prefix>:<verb-noun>` and the renderer
// surface keys it on the camelCase form of that prefix. All current preload
// files in the repo share a single channel prefix; if a file ever mixed
// prefixes the codegen rejects it so a contributor has to split the file
// or introduce explicit metadata.
function deriveNamespaceName(entries, filePath, constantName) {
  const prefixes = new Set(entries.map((e) => e.channel.split(":")[0]));
  if (prefixes.size > 1) {
    throw codegenError(
      `${constantName} mixes channel prefixes (${[...prefixes].join(", ")}) — every entry in a single constant must share a namespace`,
      filePath
    );
  }
  const [prefix] = [...prefixes];
  return kebabToCamel(prefix);
}

function kebabToCamel(value) {
  return value.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function renderOutput(namespaces) {
  const header = `// AUTO-GENERATED by scripts/codegen/ipc-renderer.mjs — do not edit by hand.
// Run \`npm run codegen:ipc-renderer\` to regenerate. Source: the
// \`*_METHOD_CHANNELS\` constants exported by each
// electron/ipc/handlers/*.preload.ts (files with
// \`export const RENDERER_API_SKIP = true\` are intentionally skipped).
// The hand-maintained ElectronAPI in api.ts extends this interface.

import type { IpcInvokeMap } from "./maps.js";

`;

  const body = ["export interface GeneratedElectronAPI {"];
  for (const ns of namespaces) {
    body.push(`  ${ns.name}: {`);
    for (const entry of ns.methods) {
      const channelLiteral = JSON.stringify(entry.channel);
      body.push(
        `    ${entry.method}(...args: IpcInvokeMap[${channelLiteral}]["args"]): Promise<IpcInvokeMap[${channelLiteral}]["result"]>;`
      );
    }
    body.push(`  };`);
  }
  body.push("}");
  body.push("");
  return header + body.join("\n");
}

function codegenError(message, filePath) {
  const rel = filePath ? path.relative(REPO_ROOT, filePath) : "";
  const err = new Error(`[ipc-renderer codegen] ${rel ? `${rel}: ` : ""}${message}`);
  err.filePath = filePath;
  return err;
}

function normalizeLineEndings(s) {
  return s.replace(/\r\n/g, "\n");
}

async function loadPrettier() {
  try {
    return await import("prettier");
  } catch {
    return null;
  }
}

async function format(content) {
  const prettier = await loadPrettier();
  if (!prettier) return content;
  const options = await prettier.resolveConfig(OUTPUT_PATH);
  return prettier.format(content, {
    ...options,
    parser: "typescript",
    filepath: OUTPUT_PATH,
  });
}

async function main() {
  const checkMode = process.argv.includes("--check");

  let generated;
  try {
    generated = await generateRendererApi();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const formatted = normalizeLineEndings(await format(generated));

  if (checkMode) {
    if (!existsSync(OUTPUT_PATH)) {
      console.error(
        `::error file=${path.relative(REPO_ROOT, OUTPUT_PATH)}::missing generated file — run \`npm run codegen:ipc-renderer\` and commit the result.`
      );
      process.exit(1);
    }
    const actual = normalizeLineEndings(readFileSync(OUTPUT_PATH, "utf8"));
    if (actual !== formatted) {
      console.error(
        `::error file=${path.relative(REPO_ROOT, OUTPUT_PATH)}::${path.relative(REPO_ROOT, OUTPUT_PATH)} is out of sync with preload sources. Run \`npm run codegen:ipc-renderer\` and commit the result.`
      );
      process.exit(1);
    }
    console.log("[ipc-renderer] OK — generated-api.ts matches preload sources");
    return;
  }

  writeFileSync(OUTPUT_PATH, formatted);
  console.log(`[ipc-renderer] wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
}

const isMain =
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href ||
  (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]));

if (isMain) {
  main();
}
