import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ComponentType } from "preact";

/** Gitignored scratch space; each file is named for this process and removed by `removeFixtures`. */
const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../.tmp/element-picker-preact-fixtures"
);

/**
 * A small Preact 11 app as a user's dev server would serve it: written as TSX
 * and imported through vitest's own transform, which is Vite 8's Oxc JSX
 * transform in development, so every element is made by `jsxDEV` with the
 * `__source` a real dev build carries. The pragma points it at Preact, as
 * `@preact/preset-vite` does. Kept as a string so the electron tsconfig, which
 * has no JSX, never sees it.
 */
export const FIXTURE_SOURCE = `/** @jsxImportSource preact */
import { Component, createContext, createPortal, type ComponentChildren } from "preact";

export function Card({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <section class="card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function Button({ label }: { label: string }) {
  return <button class={"action action-" + label}>{label}</button>;
}

const Alias = Button;

function Items({ items }: { items: string[] }) {
  return (
    <>
      {items.map((item) => (
        <li key={item} class="item">
          {item}
        </li>
      ))}
    </>
  );
}

class Panel extends Component<{ children?: ComponentChildren }> {
  render() {
    return <div class="panel">{this.props.children}</div>;
  }
}

const Theme = createContext("light");

const Anonymous = [() => <i class="anonymous">anonymous</i>][0]!;

function Modal({ target }: { target: Element }) {
  return createPortal(
    <div class="modal-body">
      <Button label="close" />
    </div>,
    target
  );
}

function Icon() {
  return (
    <svg class="icon">
      <linearGradient id="fade" />
    </svg>
  );
}

export function App({ portal, count }: { portal: Element; count: number }) {
  return (
    <Theme.Provider value="dark">
      <main class="app" data-count={count}>
        <Card title="Fixture">
          <Button label="go" />
        </Card>
        <ul class="list">
          <Items items={["one", "two", "three"]} />
        </ul>
        <Panel>
          <Alias label="aliased" />
        </Panel>
        <Anonymous />
        <Icon />
        <Modal target={portal} />
      </main>
    </Theme.Provider>
  );
}
`;

export interface Fixture {
  App: ComponentType<{ portal: Element; count: number }>;
  /** The absolute path the transform recorded as every element's `fileName`. */
  file: string;
}

const written: string[] = [];

function isFixture(value: unknown): value is Pick<Fixture, "App"> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { App?: unknown }).App === "function"
  );
}

export async function importFixture(): Promise<Fixture> {
  const file = path.join(OUT_DIR, `preactFixture.${process.pid}-${written.length}.tsx`);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(file, FIXTURE_SOURCE);
  written.push(file);
  const mod: unknown = await import(/* @vite-ignore */ file);
  if (!isFixture(mod)) throw new Error(`${file} has no App component`);
  return { App: mod.App, file };
}

export function removeFixtures(): void {
  for (const file of written.splice(0)) rmSync(file, { force: true });
}

/** Where `marker` starts in the fixture, as jsx-source numbers it: 1-based line and column. */
export function sourcePosition(marker: string): { line: number; column: number } {
  const offset = FIXTURE_SOURCE.indexOf(marker);
  if (offset < 0) throw new Error(`marker ${marker} not found`);
  const before = FIXTURE_SOURCE.slice(0, offset);
  return {
    line: before.split("\n").length,
    column: offset - (before.lastIndexOf("\n") + 1) + 1,
  };
}
