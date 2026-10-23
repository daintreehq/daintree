import { packageJson } from "../fixtureProject";
import { FEATURES_LITERAL, viteCommand, type FixtureSite } from "./site";

export const SOLID_VERSIONS = {
  "solid-js": "1.9.17",
  vite: "8.3.0",
  "vite-plugin-solid": "2.11.14",
} as const;

/**
 * Solid with nothing added. Its dev build compiles components away, leaving no
 * component boundaries, names or source on the page; the picker's only Solid
 * source is solid-devtools' locator, which this site doesn't install.
 */
export const SOLID: FixtureSite = {
  name: "picker-solid",
  title: "Solid site",
  files: {
    "package.json": packageJson("daintree-e2e-solid", { dev: "vite" }, SOLID_VERSIONS),
    ".gitignore": "node_modules/\ndist/\n",
    ".npmrc": "engine-strict=true\n",
    "vite.config.js": `import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({ plugins: [solid()] });
`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Daintree Solid fixture</title>
  </head>
  <body data-daintree-e2e-site>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
    "src/main.jsx": `import { render } from "solid-js/web";
import App from "./App.jsx";

render(() => <App />, document.getElementById("root"));
`,
    "src/App.jsx": `import { For } from "solid-js";
import FeatureCard from "./FeatureCard.jsx";

const features = ${FEATURES_LITERAL};

export default function App() {
  return (
    <main>
      <h1>Daintree Solid Tools</h1>
      <p>Point at an element to find the source that owns it.</p>
      <section>
        <For each={features}>
          {(feature) => <FeatureCard title={feature.title} body={feature.body} />}
        </For>
      </section>
    </main>
  );
}
`,
    "src/FeatureCard.jsx": `export default function FeatureCard(props) {
  return (
    <article>
      <h2>{props.title}</h2>
      <p>{props.body}</p>
    </article>
  );
}
`,
  },
};

export const SOLID_COMMANDS = {
  dev: (port: number) => viteCommand("dev", port),
};
