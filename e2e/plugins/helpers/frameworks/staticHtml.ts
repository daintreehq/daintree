import type { FixtureSite } from "./site";

/**
 * Hand-written HTML and a file server: no framework, no build and nothing to
 * install, so the picker has the DOM and nothing else to go on.
 */
export const STATIC_HTML: FixtureSite = {
  name: "picker-static-html",
  title: "Static site",
  install: false,
  files: {
    "package.json":
      JSON.stringify(
        { name: "daintree-e2e-static-html", private: true, scripts: { dev: "node serve.mjs" } },
        null,
        2
      ) + "\n",
    // Prints its address the way a dev server does, so the preview finds it.
    "serve.mjs": `import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const flag = process.argv.indexOf("--port");
const port = flag === -1 ? 0 : Number(process.argv[flag + 1]);
const host = "127.0.0.1";
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8" };

createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const file = pathname === "/" ? "/index.html" : pathname;
  const type = types[file.slice(file.lastIndexOf("."))];
  if (!type || file.includes("..")) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(new URL("." + file, import.meta.url));
    response.writeHead(200, { "content-type": type, "content-length": body.length });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, host, function () {
  console.log("  Local:   http://" + host + ":" + this.address().port + "/");
});
`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Daintree static fixture</title>
    <link rel="stylesheet" href="/site.css" />
  </head>
  <body data-daintree-e2e-site>
    <main>
      <h1>Daintree Static Tools</h1>
      <p>Point at an element to find the source that owns it.</p>
      <section>
        <article>
          <h2>Select</h2>
          <p>Click anything on the page.</p>
        </article>
        <article>
          <h2>Ask</h2>
          <p>Describe the change you want.</p>
        </article>
        <article>
          <h2>Ship</h2>
          <p>Your agent edits the source.</p>
        </article>
      </section>
    </main>
  </body>
</html>
`,
    "site.css": `body {
  font-family: system-ui, sans-serif;
  margin: 2rem;
}

section {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
}
`,
  },
};

export const STATIC_HTML_COMMANDS = {
  dev: (port: number) => `npm run dev -- --port ${port}`,
};
