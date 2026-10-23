import { lineOf, packageJson } from "../fixtureProject";
import { FEATURES_LITERAL, viteCommand, type FixtureSite } from "./site";

export const REACT_VITE_VERSIONS = {
  "@vitejs/plugin-react": "6.1.2",
  react: "19.3.1",
  "react-dom": "19.3.1",
  vite: "8.3.0",
} as const;

export const APP_FILE = "src/App.jsx";

const APP_SOURCE = `import FeatureCard from "./FeatureCard.jsx";

const features = ${FEATURES_LITERAL};

export default function App() {
  return (
    <main>
      <h1>Daintree React Tools</h1>
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

export const CARD_FILE = "src/FeatureCard.jsx";

const CARD_SOURCE = `export default function FeatureCard({ title, body }) {
  return (
    <article>
      <h2>{title}</h2>
      <p>{body}</p>
    </article>
  );
}
`;

/**
 * React 19 + Vite. React hands the picker the stack each element was created
 * on and nothing else, so a location exists only where the host can map that
 * stack through the dev server's source maps — which makes this the site the
 * source-map negative runs on: the same app, served by a config that drops
 * the maps of its own modules.
 */
export const REACT_VITE: FixtureSite = {
  name: "picker-react-vite",
  title: "React site",
  files: {
    "package.json": packageJson(
      "daintree-e2e-react-vite",
      {
        dev: "vite",
        "dev:no-source-maps": "vite --config vite.no-source-maps.config.js",
        build: "vite build",
        preview: "vite preview",
      },
      REACT_VITE_VERSIONS
    ),
    ".gitignore": "node_modules/\ndist/\n",
    ".npmrc": "engine-strict=true\n",
    "vite.config.js": `import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [react()] });
`,
    // `{ mappings: "" }` is Vite's own word for "this module has no map": the
    // dev server then neither inlines one nor generates its fallback, so the
    // app's modules arrive exactly as a server built without maps sends them.
    "vite.no-source-maps.config.js": `import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config.js";

export default mergeConfig(
  base,
  defineConfig({
    plugins: [
      {
        name: "no-source-maps",
        enforce: "post",
        transform(code, id) {
          if (id.includes("/node_modules/")) return null;
          return { code, map: { mappings: "" } };
        },
      },
    ],
  })
);
`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Daintree React fixture</title>
  </head>
  <body data-daintree-e2e-site>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
    "src/main.jsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
`,
    [APP_FILE]: APP_SOURCE,
    [CARD_FILE]: CARD_SOURCE,
  },
};

export const REACT_VITE_COMMANDS = {
  dev: (port: number) => viteCommand("dev", port),
  noSourceMaps: (port: number) => viteCommand("dev:no-source-maps", port),
  /** Serves what `npm run build` left in `dist/`. */
  production: (port: number) => viteCommand("preview", port),
};

export const REACT_HEADING = `${APP_FILE}:${lineOf(APP_SOURCE, "<h1>")}`;
export const REACT_CARD_HEADING = `${CARD_FILE}:${lineOf(CARD_SOURCE, "<h2>")}`;
