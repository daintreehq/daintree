import { lineOf, packageJson } from "../fixtureProject";
import { FEATURES_LITERAL, viteCommand, type FixtureSite } from "./site";

export const PREACT_VERSIONS = {
  "@preact/preset-vite": "2.10.6",
  preact: "11.0.1",
  vite: "8.3.0",
} as const;

export const APP_FILE = "src/App.jsx";

const APP_SOURCE = `import FeatureCard from "./FeatureCard.jsx";

const features = ${FEATURES_LITERAL};

export default function App() {
  return (
    <main>
      <h1>Daintree Preact Tools</h1>
      <p>Point at an element to find the source that owns it.</p>
      <section>
        {features.map((feature) => (
          <FeatureCard key={feature.title} title={feature.title} body={feature.body} />
        ))}
      </section>
    </main>
  );
}
`;

/**
 * Preact through its own Vite preset, which in dev adds the JSX source
 * transform and `preact/debug` that put `__source` on every vnode.
 */
export const PREACT: FixtureSite = {
  name: "picker-preact",
  title: "Preact site",
  files: {
    "package.json": packageJson("daintree-e2e-preact", { dev: "vite" }, PREACT_VERSIONS),
    ".gitignore": "node_modules/\ndist/\n",
    ".npmrc": "engine-strict=true\n",
    "vite.config.js": `import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [preact()] });
`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Daintree Preact fixture</title>
  </head>
  <body data-daintree-e2e-site>
    <div id="app"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
    "src/main.jsx": `import { render } from "preact";
import App from "./App.jsx";

render(<App />, document.getElementById("app"));
`,
    [APP_FILE]: APP_SOURCE,
    "src/FeatureCard.jsx": `export default function FeatureCard({ title, body }) {
  return (
    <article>
      <h2>{title}</h2>
      <p>{body}</p>
    </article>
  );
}
`,
  },
};

export const PREACT_COMMANDS = {
  dev: (port: number) => viteCommand("dev", port),
};

export const PREACT_HEADING = `${APP_FILE}:${lineOf(APP_SOURCE, "<h1>")}`;
