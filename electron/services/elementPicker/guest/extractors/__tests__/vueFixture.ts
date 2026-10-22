import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElementNode, TemplateChildNode } from "@vue/compiler-dom";
import type { Component } from "vue";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";

/**
 * Real Vue 3.5 output for the extractor to read. Each fixture `.vue` file is
 * compiled the way `@vitejs/plugin-vue` 6 compiles it for Vite's dev server —
 * script and template apart, the template's render attached to the
 * component, `__file` set to the file's absolute path — and run on Vue's own
 * browser builds: the development one, or the production one, which leaves no
 * dev metadata at all. A server build renders through `vue/server-renderer`
 * for a page to hydrate, as Nuxt does.
 *
 * `vite-plugin-vue-inspector` is reproduced as the user would run it. Its
 * compile step stamps the template source; with `recorded`, its version 7
 * client step then moves each stamp off the vnode's props as the vnode is
 * made, so the stamp never reaches the DOM.
 */

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "../../../__tests__/fixtures/vue");
/** Gitignored scratch space; each build is named for this process and removed by `removeFixtures`. */
const OUT_DIR = path.resolve(HERE, "../../../../../../.tmp/element-picker-vue-fixtures");

const RUNTIMES = {
  dev: require.resolve("vue/dist/vue.esm-browser.js"),
  prod: require.resolve("vue/dist/vue.esm-browser.prod.js"),
} as const;

export type VueRuntime = typeof import("vue");
export type RuntimeMode = keyof typeof RUNTIMES;
export type Inspector = "none" | "attribute" | "recorded";

export interface FixtureFile {
  /** Absolute, as `@vitejs/plugin-vue` reports it in `__file`. */
  file: string;
  source: string;
}

/** Where the fixture apps claim to live; nothing is read from there. */
export const VITE_ROOT = "/projects/shop";
export const NUXT_ROOT = "/projects/store";
export const NUXT_ROOT_COMPONENT = `${NUXT_ROOT}/node_modules/nuxt/dist/app/components/nuxt-root.vue`;

/** What Nuxt mounts: its own root component, from the dependency, around the app's. */
const NUXT_ROOT_SOURCE = `<script setup>
import App from "#app-component";
</script>

<template>
  <Suspense>
    <App />
  </Suspense>
</template>
`;

export function loadRuntime(mode: RuntimeMode): Promise<VueRuntime> {
  return import(/* @vite-ignore */ RUNTIMES[mode]) as Promise<VueRuntime>;
}

/** A fixture file's text, by its path under `__tests__/fixtures/vue`. */
export function fixtureSource(relative: string): string {
  return readFileSync(path.join(FIXTURES, ...relative.split("/")), "utf8");
}

function filesUnder(directory: string, prefix = ""): string[] {
  return readdirSync(directory).flatMap((name) => {
    const absolute = path.join(directory, name);
    const relative = prefix + name;
    return statSync(absolute).isDirectory() ? filesUnder(absolute, `${relative}/`) : [relative];
  });
}

/** The Vite app: the top-level fixtures, as `src/` of an app at `VITE_ROOT`. */
export function viteApp(): FixtureFile[] {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith(".vue"))
    .map((name) => ({ file: `${VITE_ROOT}/src/${name}`, source: fixtureSource(name) }));
}

/** The Nuxt 4 app: `nuxt/` as the `app/` directory of a project at `NUXT_ROOT`, with Nuxt's root around it. */
export function nuxtApp(): FixtureFile[] {
  return [
    ...filesUnder(path.join(FIXTURES, "nuxt")).map((relative) => ({
      file: `${NUXT_ROOT}/app/${relative}`,
      source: fixtureSource(`nuxt/${relative}`),
    })),
    { file: NUXT_ROOT_COMPONENT, source: NUXT_ROOT_SOURCE },
  ];
}

/** Where `marker` starts in `source`, as Vue's template parser counts it: 1-based line and column. */
export function positionOf(source: string, marker: string): { line: number; column: number } {
  const offset = source.indexOf(marker);
  if (offset < 0) throw new Error(`marker ${marker} not found`);
  const before = source.slice(0, offset);
  return { line: before.split("\n").length, column: offset - before.lastIndexOf("\n") };
}

/** The stamp `vite-plugin-vue-inspector` writes for the tag starting at `marker`. */
export function stampFor(relative: string, source: string, marker: string): string {
  const { line, column } = positionOf(source, marker);
  return `${relative}:${line}:${column}`;
}

const EXCLUDED_TAGS = new Set(["template", "script", "style"]);

/**
 * The inspector's compile step, as its `compileTemplateFallback` does it: every
 * element and component tag gains `data-v-inspector` with the position Vue's
 * parser gives the tag, written after its last attribute or its name.
 */
function stampTemplate(source: string, relative: string): string {
  const { descriptor } = parse(source);
  const inserts: Array<{ at: number; text: string }> = [];
  const visit = (nodes: TemplateChildNode[]) => {
    for (const node of nodes) {
      if (node.type !== 1) continue;
      const element = node as ElementNode;
      if (!EXCLUDED_TAGS.has(element.tag) && (element.tagType === 0 || element.tagType === 1)) {
        const at = element.props.length
          ? Math.max(...element.props.map((prop) => prop.loc.end.offset))
          : element.loc.start.offset + element.tag.length + 1;
        const { line, column } = element.loc.start;
        inserts.push({ at, text: ` data-v-inspector="${relative}:${line}:${column}"` });
      }
      visit(element.children);
    }
  };
  visit(descriptor.template?.ast?.children ?? []);
  let out = source;
  for (const { at, text } of inserts.sort((a, b) => b.at - a.at)) {
    out = out.slice(0, at) + text + out.slice(at);
  }
  return out;
}

/** Version 7's client step: a vnode's stamp moves to a hidden prop as the vnode is made. */
function recorderSource(runtime: string): string {
  const spec = JSON.stringify(runtime);
  const factories = [
    "h",
    "createElementVNode",
    "createElementBlock",
    "createBlock",
    "createVNode",
    "createStaticVNode",
  ];
  return [
    `import * as Vue from ${spec};`,
    `export * from ${spec};`,
    `function record(node) {`,
    `  if (!node || typeof node !== "object") return node;`,
    `  const props = (node.props ||= {});`,
    `  const data = props["data-v-inspector"];`,
    `  if (typeof data !== "string") return node;`,
    `  delete props["data-v-inspector"];`,
    `  if (!("__v_inspector" in props)) {`,
    `    Object.defineProperty(props, "__v_inspector", { value: data, configurable: true, enumerable: false });`,
    `  }`,
    `  return node;`,
    `}`,
    ...factories.map((name) => `export const ${name} = (...args) => record(Vue.${name}(...args));`),
  ].join("\n");
}

const written: string[] = [];
let builds = 0;

export interface BuildOptions {
  runtime: RuntimeMode;
  inspector: Inspector;
  /** The dev server's working directory, which stamps are relative to. */
  root: string;
  /** Compile for `vue/server-renderer` instead of the browser. */
  ssr?: boolean;
}

/**
 * Compile `files` as one app and import its `entry`. A client build imports
 * Vue from the browser runtime its `runtime` names; a server build from `vue`
 * itself, the copy `vue/server-renderer` renders with.
 */
export async function buildApp(
  files: FixtureFile[],
  entry: string,
  options: BuildOptions
): Promise<Component> {
  builds += 1;
  const dir = path.join(OUT_DIR, `${process.pid}-${builds}`);
  mkdirSync(dir, { recursive: true });
  written.push(dir);
  const outputOf = (file: string) =>
    path.join(dir, `${file.replace(/^\/+/, "").replaceAll("/", "__")}.mjs`);
  let runtime = "vue";
  if (!options.ssr) {
    runtime = RUNTIMES[options.runtime];
    if (options.inspector === "recorded") {
      runtime = path.join(dir, "vue-recorded.mjs");
      writeFileSync(runtime, recorderSource(RUNTIMES[options.runtime]));
    }
  }
  const prod = options.runtime === "prod";
  const aliases: Record<string, string> = { "#app-component": `${NUXT_ROOT}/app/app.vue` };

  for (const { file, source } of files) {
    const stamped =
      options.inspector === "none"
        ? source
        : stampTemplate(source, path.posix.relative(options.root, file));
    const id = createHash("sha256").update(file).digest("hex").slice(0, 8);
    const { descriptor, errors } = parse(stamped, { filename: file });
    if (errors.length > 0) throw new Error(`${file}: ${errors[0]}`);
    const script =
      descriptor.script || descriptor.scriptSetup
        ? compileScript(descriptor, {
            id,
            isProd: prod,
            inlineTemplate: false,
            genDefaultAs: "_sfc_main",
          })
        : null;
    const template = descriptor.template
      ? compileTemplate({
          source: descriptor.template.content,
          filename: file,
          id,
          isProd: prod,
          ssr: options.ssr === true,
          ssrCssVars: [],
          compilerOptions: { bindingMetadata: script?.bindings },
        })
      : null;
    if (template && template.errors.length > 0) {
      throw new Error(`${file}: ${String(template.errors[0])}`);
    }
    const renderKey = options.ssr ? "ssrRender" : "render";
    let code = [
      script ? script.content : "const _sfc_main = {};",
      template
        ? template.code.replace(`export function ${renderKey}(`, `function _sfc_${renderKey}(`)
        : "",
      template ? `_sfc_main.${renderKey} = _sfc_${renderKey};` : "",
      prod ? "" : `_sfc_main.__file = ${JSON.stringify(file)};`,
      "export default _sfc_main;",
    ].join("\n");
    code = code.replace(/from\s+(["'])([^"']+)\1/g, (match, _quote: string, spec: string) => {
      if (spec === "vue") return `from ${JSON.stringify(runtime)}`;
      const target =
        aliases[spec] ??
        (spec.endsWith(".vue") ? path.posix.resolve(path.posix.dirname(file), spec) : null);
      return target === null ? match : `from ${JSON.stringify(outputOf(target))}`;
    });
    writeFileSync(outputOf(file), code);
  }
  const mod = (await import(/* @vite-ignore */ outputOf(entry))) as { default: Component };
  return mod.default;
}

/** What the server sends for `root`: rendered by Vue's own server renderer, as Nuxt renders a page. */
export async function renderToHtml(root: Component): Promise<string> {
  const [{ createSSRApp }, { renderToString }] = await Promise.all([
    import("vue"),
    import("vue/server-renderer"),
  ]);
  return renderToString(createSSRApp(root));
}

export function removeFixtures(): void {
  for (const dir of written.splice(0)) rmSync(dir, { recursive: true, force: true });
}
