import { lineOf, packageJson } from "../fixtureProject";
import { FEATURES_LITERAL, type FixtureSite } from "./site";

export const NEXT_VERSIONS = {
  next: "16.4.2",
  react: "19.3.1",
  "react-dom": "19.3.1",
} as const;

export const PAGE_FILE = "app/page.jsx";

const PAGE_SOURCE = `import FeatureCard from "./FeatureCard.jsx";

const features = ${FEATURES_LITERAL};

export default function Page() {
  return (
    <main>
      <h1>Daintree Next.js Tools</h1>
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

export const CARD_FILE = "app/FeatureCard.jsx";

// A client component, so the card is created in the browser and React's own
// creation stack names it: the path the React resolver already maps.
const CARD_SOURCE = `"use client";

export default function FeatureCard({ title, body }) {
  return (
    <article>
      <h2>{title}</h2>
      <p>{body}</p>
    </article>
  );
}
`;

/**
 * Next.js 16 on its default Turbopack dev server, App Router: a server
 * component page drawing client component cards.
 */
export const NEXT: FixtureSite = {
  name: "picker-next",
  title: "Next.js site",
  installTimeoutMs: 8 * 60_000,
  files: {
    "package.json": packageJson(
      "daintree-e2e-next",
      { dev: "next dev", build: "next build", start: "next start" },
      NEXT_VERSIONS
    ),
    ".gitignore": "node_modules/\n.next/\n",
    ".npmrc": "engine-strict=true\n",
    // Next 16 writes an AGENTS.md into the project on its first dev start
    // unless told not to, which would leave the fixture repo dirty.
    "next.config.mjs": "export default { agentRules: false };\n",
    "app/layout.jsx": `export const metadata = { title: "Daintree Next.js fixture" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body data-daintree-e2e-site="">{children}</body>
    </html>
  );
}
`,
    [PAGE_FILE]: PAGE_SOURCE,
    [CARD_FILE]: CARD_SOURCE,
  },
};

export const NEXT_COMMANDS = {
  dev: (port: number) => `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
};

export const NEXT_CARD_HEADING = `${CARD_FILE}:${lineOf(CARD_SOURCE, "<h2>")}`;
export const NEXT_PAGE_HEADING = `${PAGE_FILE}:${lineOf(PAGE_SOURCE, "<h1>")}`;
