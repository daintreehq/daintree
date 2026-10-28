import { packageJson } from "../fixtureProject";
import { FEATURES_LITERAL, type FixtureSite } from "./site";

/** TypeScript is held to the range `@angular/compiler-cli` 22.2 accepts. */
export const ANGULAR_VERSIONS = {
  "@angular/build": "22.2.4",
  "@angular/cli": "22.2.4",
  "@angular/common": "22.2.3",
  "@angular/compiler": "22.2.3",
  "@angular/compiler-cli": "22.2.3",
  "@angular/core": "22.2.3",
  "@angular/platform-browser": "22.2.3",
  rxjs: "7.8.2",
  tslib: "2.8.1",
  typescript: "6.0.3",
} as const;

export const APP_FILE = "src/app/app.ts";
export const CARD_FILE = "src/app/feature-card.ts";

const ANGULAR_JSON = {
  $schema: "./node_modules/@angular/cli/lib/config/schema.json",
  version: 1,
  // Off here, or the first `ng` run stops to ask.
  cli: { analytics: false, packageManager: "npm" },
  newProjectRoot: "projects",
  projects: {
    site: {
      projectType: "application",
      root: "",
      sourceRoot: "src",
      prefix: "app",
      architect: {
        build: {
          builder: "@angular/build:application",
          options: { browser: "src/main.ts", index: "src/index.html", tsConfig: "tsconfig.json" },
          configurations: {
            production: { outputHashing: "all" },
            development: { optimization: false, extractLicenses: false, sourceMap: true },
          },
          defaultConfiguration: "production",
        },
        serve: {
          builder: "@angular/build:dev-server",
          configurations: {
            production: { buildTarget: "site:build:production" },
            development: { buildTarget: "site:build:development" },
          },
          defaultConfiguration: "development",
        },
      },
    },
  },
};

/**
 * Angular 22, standalone and zoneless, served by `@angular/build`'s dev
 * server. A stock dev build gives components their class's file and line
 * (`ɵsetClassDebugInfo`); template locations need a compiler option this site
 * leaves at its default.
 */
export const ANGULAR: FixtureSite = {
  name: "picker-angular",
  title: "Angular site",
  installTimeoutMs: 8 * 60_000,
  files: {
    "package.json": packageJson(
      "daintree-e2e-angular",
      { dev: "ng serve", build: "ng build" },
      ANGULAR_VERSIONS
    ),
    ".gitignore": "node_modules/\ndist/\n.angular/\n",
    ".npmrc": "engine-strict=true\n",
    "angular.json": JSON.stringify(ANGULAR_JSON, null, 2) + "\n",
    "tsconfig.json":
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            skipLibCheck: true,
            isolatedModules: true,
            importHelpers: true,
            target: "ES2022",
            module: "preserve",
          },
          angularCompilerOptions: { strictTemplates: true },
          files: ["src/main.ts"],
        },
        null,
        2
      ) + "\n",
    "src/index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Daintree Angular fixture</title>
    <base href="/" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body data-daintree-e2e-site>
    <app-root></app-root>
  </body>
</html>
`,
    "src/main.ts": `import { bootstrapApplication } from "@angular/platform-browser";
import { App } from "./app/app";

bootstrapApplication(App).catch((error) => console.error(error));
`,
    [APP_FILE]: `import { Component } from "@angular/core";
import { FeatureCard } from "./feature-card";

@Component({
  selector: "app-root",
  imports: [FeatureCard],
  template: \`
    <main>
      <h1>Daintree Angular Tools</h1>
      <p>Point at an element to find the source that owns it.</p>
      <section>
        @for (feature of features; track feature.title) {
          <app-feature-card [title]="feature.title" [body]="feature.body" />
        }
      </section>
    </main>
  \`,
})
export class App {
  protected readonly features = ${FEATURES_LITERAL};
}
`,
    [CARD_FILE]: `import { Component, input } from "@angular/core";

@Component({
  selector: "app-feature-card",
  template: \`
    <article>
      <h2>{{ title() }}</h2>
      <p>{{ body() }}</p>
    </article>
  \`,
})
export class FeatureCard {
  readonly title = input.required<string>();
  readonly body = input.required<string>();
}
`,
  },
};

export const ANGULAR_COMMANDS = {
  dev: (port: number) => `npm run dev -- --host 127.0.0.1 --port ${port}`,
};
