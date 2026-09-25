// Hand-written ESM, no build: bare `react` and `@daintreehq/tour/*` resolve
// through the host import map, so `useCue` reads the host's own player.
import { createElement as h } from "react";
import { useCue } from "@daintreehq/tour/react";
import { cn, reveal } from "@daintreehq/tour/kit";

const PAGES = ["Home", "Pricing", "Blog"];

function IntroScene() {
  const title = useCue("title");
  const pages = useCue("pages");
  return h(
    "div",
    {
      className: "absolute inset-0 flex flex-col items-center justify-center gap-4 bg-surface-canvas",
      "data-testid": "acme-intro",
    },
    h(
      "span",
      {
        className: cn(
          "rounded-full border border-category-amber-border bg-category-amber-subtle px-2.5 py-1 text-2xs text-category-amber-text",
          reveal(title)
        ),
      },
      "Acme site builder"
    ),
    h(
      "ul",
      { className: cn("flex gap-2", reveal(pages)) },
      ...PAGES.map((page) =>
        h(
          "li",
          {
            key: page,
            className:
              "rounded-md border border-border-default bg-surface-panel px-3 py-1.5 text-xs text-text-primary",
          },
          page
        )
      )
    )
  );
}

function PublishScene() {
  const published = useCue("publish");
  return h(
    "div",
    {
      className: "absolute inset-0 flex items-center justify-center bg-surface-canvas",
      "data-testid": "acme-publish",
    },
    h(
      "button",
      {
        type: "button",
        tabIndex: -1,
        className: cn(
          "rounded-md px-4 py-2 text-sm font-medium",
          published
            ? "bg-category-teal-subtle text-category-teal-text"
            : "bg-surface-panel text-text-secondary"
        ),
      },
      published ? "Published" : "Publish"
    )
  );
}

export default {
  scenes: { intro: IntroScene, publish: PublishScene },
  chapterTitles: { intro: "Build your pages", publish: "Go live" },
};
