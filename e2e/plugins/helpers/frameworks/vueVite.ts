import { packageJson } from "../fixtureProject";
import { FEATURES_LITERAL, viteCommand, type FixtureSite } from "./site";

export const VUE_VITE_VERSIONS = {
  "@vitejs/plugin-vue": "6.0.10",
  vite: "8.3.0",
  vue: "3.5.44",
} as const;

export const APP_FILE = "src/App.vue";
export const CARD_FILE = "src/FeatureCard.vue";

/**
 * Vue 3 + Vite. A stock Vue dev build names each component's file (`__file`)
 * and nothing finer, so this site traces to a file, never to a line.
 */
export const VUE_VITE: FixtureSite = {
  name: "picker-vue-vite",
  title: "Vue site",
  files: {
    "package.json": packageJson("daintree-e2e-vue-vite", { dev: "vite" }, VUE_VITE_VERSIONS),
    ".gitignore": "node_modules/\ndist/\n",
    ".npmrc": "engine-strict=true\n",
    "vite.config.js": `import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [vue()] });
`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Daintree Vue fixture</title>
  </head>
  <body data-daintree-e2e-site>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`,
    "src/main.js": `import { createApp } from "vue";
import App from "./App.vue";

createApp(App).mount("#app");
`,
    [APP_FILE]: `<script setup>
import FeatureCard from "./FeatureCard.vue";

const features = ${FEATURES_LITERAL};
</script>

<template>
  <main>
    <h1>Daintree Vue Tools</h1>
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

export const VUE_VITE_COMMANDS = {
  dev: (port: number) => viteCommand("dev", port),
};
