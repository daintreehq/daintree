import { lineOf, packageJson } from "../fixtureProject";
import { FEATURES_LITERAL, type FixtureSite } from "./site";

/** 7.4.2 needs Node 22.23.4, past the repo's own 22.23.2, and `engine-strict` refuses it. */
export const ASTRO_VERSIONS = { astro: "7.4.1" } as const;

export const PAGE_FILE = "src/pages/index.astro";

const PAGE_SOURCE = `---
import FeatureCard from "../components/FeatureCard.astro";

const features = ${FEATURES_LITERAL};
---

<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Daintree Astro fixture</title>
  </head>
  <body data-daintree-e2e-site>
    <main>
      <h1>Daintree Astro Tools</h1>
      <p>Point at an element to find the source that owns it.</p>
      <section>
        {features.map((feature) => <FeatureCard title={feature.title} body={feature.body} />)}
      </section>
    </main>
  </body>
</html>
`;

/**
 * Astro with no UI framework: server-rendered markup only, served with the
 * source attributes its compiler stamps while the dev toolbar is on, which the
 * toolbar then takes off the elements, and no islands or scoped styles to say
 * Astro once they are gone.
 */
export const ASTRO: FixtureSite = {
  name: "picker-astro",
  title: "Astro site",
  files: {
    "package.json": packageJson(
      "daintree-e2e-astro",
      { dev: "astro dev", build: "astro build", preview: "astro preview" },
      ASTRO_VERSIONS
    ),
    ".gitignore": "node_modules/\ndist/\n.astro/\n",
    ".npmrc": "engine-strict=true\n",
    [PAGE_FILE]: PAGE_SOURCE,
    "src/components/FeatureCard.astro": `---
const { title, body } = Astro.props;
---

<article>
  <h2>{title}</h2>
  <p>{body}</p>
</article>
`,
  },
};

export const ASTRO_COMMANDS = {
  dev: (port: number) => `npm run dev -- --host 127.0.0.1 --port ${port}`,
};

export const ASTRO_HEADING = `${PAGE_FILE}:${lineOf(PAGE_SOURCE, "<h1>")}`;
