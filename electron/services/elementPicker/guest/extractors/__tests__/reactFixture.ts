import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ComponentType } from "react";

const require = createRequire(import.meta.url);
/** Gitignored scratch space; each file is named for this process and removed by `removeFixtures`. */
const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../../.tmp/element-picker-react-fixtures"
);

/** Untyped package: only the call this harness makes. */
const babel = require("@babel/core") as {
  transformSync(code: string, options: Record<string, unknown>): { code?: string | null } | null;
};

/**
 * A small React app as a user's dev server would serve it: written as TSX and
 * imported through vitest's own JSX transform, which emits `jsxDEV` calls
 * exactly as Vite's dev transform does, so React captures a real `_debugStack`
 * for every element. Kept as a string so the electron tsconfig, which has no
 * JSX, never sees it.
 */
export const FIXTURE_SOURCE = `
import { forwardRef, memo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Card({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function Button({ label }: { label: string }) {
  return <button className={"action action-" + label}>{label}</button>;
}

function Items({ items }: { items: string[] }) {
  return (
    <>
      {items.map((item) => (
        <li key={item} className="item">
          {item}
        </li>
      ))}
    </>
  );
}

const Badge = memo(
  function Badge({ count }: { count: number }) {
    return <span className="badge">{count}</span>;
  },
  (previous, next) => previous.count === next.count
);

const Pill = memo(function Pill({ text }: { text: string }) {
  return <em className="pill">{text}</em>;
});
Pill.displayName = "StatusPill";

const Field = forwardRef<HTMLInputElement, { name: string }>(function Field({ name }, ref) {
  return <input ref={ref} name={name} className="field" />;
});

function Notice({ bumped }: { bumped: boolean }) {
  return (
    <>
      <b className="notice-title">Notice</b>
      {bumped ? <p className="notice-body">bumped</p> : null}
    </>
  );
}

function Modal({ target }: { target: Element }) {
  return createPortal(
    <div className="modal-body">
      <Button label="close" />
    </div>,
    target
  );
}

export function App({ portal }: { portal: Element }) {
  const [count, setCount] = useState(0);
  return (
    <main className="app">
      <Card title="Fixture">
        <Button label="go" />
      </Card>
      <ul className="list">
        <Items items={["one", "two", "three"]} />
      </ul>
      <Badge count={count} />
      <Pill text="ok" />
      <Field name="email" />
      <Notice bumped={count > 0} />
      <Modal target={portal} />
      <button className="bump" onClick={() => setCount((value) => value + 1)}>
        bump {count}
      </button>
    </main>
  );
}
`;

const written: string[] = [];

function isAppModule(value: unknown): value is { App: ComponentType<{ portal: Element }> } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { App?: unknown }).App === "function"
  );
}

/**
 * The fixture with React Compiler on or off. Compiled with the compiler's own
 * Babel plugin, as a user's Vite config would run it, and refused if the
 * output is not memoized — a compiler bail-out would make the "on" case prove
 * nothing.
 */
export async function importFixture(
  compiler: boolean
): Promise<{ App: ComponentType<{ portal: Element }> }> {
  let code = FIXTURE_SOURCE;
  if (compiler) {
    const result = babel.transformSync(FIXTURE_SOURCE, {
      filename: "reactFixture.tsx",
      babelrc: false,
      configFile: false,
      plugins: [
        [
          require.resolve("babel-plugin-react-compiler"),
          { target: "19", compilationMode: "infer" },
        ],
      ],
      parserOpts: { sourceType: "module", plugins: ["typescript", "jsx"] },
    });
    code = result?.code ?? "";
    if (!code.includes("react/compiler-runtime")) {
      throw new Error("the fixture was not compiled; the compiler-on case would prove nothing");
    }
  }
  const target = path.join(
    OUT_DIR,
    `reactFixture.${compiler ? "compiled" : "plain"}.${process.pid}-${written.length}.tsx`
  );
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(target, code);
  written.push(target);
  const mod: unknown = await import(/* @vite-ignore */ target);
  if (!isAppModule(mod)) throw new Error(`${target} has no App component`);
  return mod;
}

export function removeFixtures(): void {
  for (const file of written.splice(0)) rmSync(file, { force: true });
}
