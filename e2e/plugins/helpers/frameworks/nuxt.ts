import { packageJson } from "../fixtureProject";
import { FEATURES_LITERAL, type FixtureSite } from "./site";

export const NUXT_VERSIONS = {
  nuxt: "4.6.2",
  vue: "3.5.44",
  "vue-router": "5.4.0",
} as const;

export const APP_FILE = "app/app.vue";
export const CARD_FILE = "app/components/FeatureCard.vue";

/**
 * Nuxt 4: Vue rendered on the server and hydrated, which is what most Vue
 * sites a preview shows are. Telemetry and DevTools are off so the dev server
 * neither asks a question on first run nor draws its own UI over the page.
 */
export const NUXT: FixtureSite = {
  name: "picker-nuxt",
  title: "Nuxt site",
  installTimeoutMs: 8 * 60_000,
  files: {
    "package.json": packageJson(
      "daintree-e2e-nuxt",
      { dev: "nuxt dev", build: "nuxt build", preview: "nuxt preview" },
      NUXT_VERSIONS
    ),
    ".gitignore": "node_modules/\n.nuxt/\n.output/\n",
    ".npmrc": "engine-strict=true\n",
    "nuxt.config.ts": `export default defineNuxtConfig({
  compatibilityDate: "2026-09-01",
  devtools: { enabled: false },
  telemetry: false,
  app: { head: { bodyAttrs: { "data-daintree-e2e-site": "true" } } },
});
`,
    [APP_FILE]: `<script setup>
const features = ${FEATURES_LITERAL};
</script>

<template>
  <main>
    <h1>Daintree Nuxt Tools</h1>
    <p>Point at an element to find the source that owns it.</p>
    <section>
      <FeatureCard
        v-for="feature in features"
        :key="feature.title"
        :title="feature.title"
        :body="feature.body"
      />
    </section>
  </main>
</template>
`,
    [CARD_FILE]: `<script setup>
defineProps({ title: String, body: String });
</script>

<template>
  <article>
    <h2>{{ title }}</h2>
    <p>{{ body }}</p>
  </article>
</template>
`,
  },
};

export const NUXT_COMMANDS = {
  dev: (port: number) => `npm run dev -- --host 127.0.0.1 --port ${port}`,
};
