import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NetworkAllowance } from "../sourceAccess.js";
import { revisionOf } from "../sourceAccess.js";
import {
  MAX_SOURCE_MAP_REDIRECTS,
  createSourceMapProvider,
  decodeDataUrl,
  sourceMappingReference,
} from "../sourceMapFetcher.js";

type Route = (request: http.IncomingMessage, response: http.ServerResponse) => void;

interface Server {
  origin: string;
  routes: Map<string, Route>;
  hits: string[];
}

const servers: http.Server[] = [];

async function serve(): Promise<Server> {
  const routes = new Map<string, Route>();
  const hits: string[] = [];
  const server = http.createServer((request, response) => {
    hits.push(request.url ?? "");
    const route = routes.get((request.url ?? "").split("?")[0]!);
    if (route) route(request, response);
    else response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, routes, hits };
}

const body =
  (text: string, headers: Record<string, string> = {}): Route =>
  (_request, response) =>
    response.writeHead(200, { "content-type": "text/javascript", ...headers }).end(text);

const redirect =
  (location: string, status = 302): Route =>
  (_request, response) =>
    response.writeHead(status, { location }).end();

const MAP = JSON.stringify({
  version: 3,
  sources: ["Card.tsx"],
  names: [],
  mappings: "AAAA",
  sourcesContent: ["export {}"],
});

const inline = (map = MAP) =>
  `export const a = 1;\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString("base64")}\n`;

interface Meter extends NetworkAllowance {
  requests: number;
  received: number;
}

function meter(maxRequests = 8, maxBytes = 4 * 1024 * 1024): Meter {
  const spent: Meter = {
    requests: 0,
    received: 0,
    request: () => {
      if (spent.requests >= maxRequests) return false;
      spent.requests += 1;
      return true;
    },
    bytes: (count) => {
      spent.received += count;
      return spent.received <= maxBytes;
    },
  };
  return spent;
}

let preview: Server;
let elsewhere: Server;
const provider = createSourceMapProvider();

function fetchMap(
  generatedUrl: string,
  allowance = meter(),
  signal = new AbortController().signal
) {
  return provider(
    { workspaceId: "ws", previewOrigin: preview.origin, generatedUrl, allowance },
    signal
  );
}

beforeEach(async () => {
  preview = await serve();
  elsewhere = await serve();
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

describe("source map provider", () => {
  it("decodes an inline map and resolves its sources against the module", async () => {
    preview.routes.set("/src/Card.tsx", body(inline()));
    const result = await fetchMap(`${preview.origin}/src/Card.tsx?t=1#frag`);
    expect(result).toEqual({
      ok: true,
      value: {
        url: null,
        base: `${preview.origin}/src/Card.tsx?t=1`,
        revision: revisionOf(new TextEncoder().encode(MAP)),
        text: MAP,
      },
    });
  });

  it("decodes a percent-encoded inline map whatever charset it names", async () => {
    preview.routes.set(
      "/a.js",
      body(
        `x;\n//# sourceMappingURL=data:application/json;charset=utf-8,${encodeURIComponent(MAP)}`
      )
    );
    await expect(fetchMap(`${preview.origin}/a.js`)).resolves.toMatchObject({
      ok: true,
      value: { url: null, text: MAP },
    });
  });

  it("fetches an external map relative to the module", async () => {
    preview.routes.set("/assets/a.js", body("x;\n//# sourceMappingURL=maps/a.js.map\n"));
    preview.routes.set("/assets/maps/a.js.map", body(MAP));
    await expect(fetchMap(`${preview.origin}/assets/a.js`)).resolves.toEqual({
      ok: true,
      value: {
        url: `${preview.origin}/assets/maps/a.js.map`,
        base: `${preview.origin}/assets/maps/a.js.map`,
        revision: revisionOf(new TextEncoder().encode(MAP)),
        text: MAP,
      },
    });
  });

  it("takes the SourceMap header over the comment, and X-SourceMap after it", async () => {
    preview.routes.set(
      "/a.js",
      body("x;\n//# sourceMappingURL=wrong.map", {
        SourceMap: "/right.map",
        "X-SourceMap": "/old.map",
      })
    );
    preview.routes.set("/b.js", body("x;", { "X-SourceMap": "/right.map" }));
    preview.routes.set("/right.map", body(MAP));
    await expect(fetchMap(`${preview.origin}/a.js`)).resolves.toMatchObject({
      value: { url: `${preview.origin}/right.map` },
    });
    await expect(fetchMap(`${preview.origin}/b.js`)).resolves.toMatchObject({
      value: { url: `${preview.origin}/right.map` },
    });
  });

  it("follows a redirect on the preview origin and resolves inline sources from where it landed", async () => {
    preview.routes.set("/src/Card.tsx", redirect("/src/v2/Card.tsx"));
    preview.routes.set("/src/v2/Card.tsx", body(inline()));
    const allowance = meter();
    await expect(fetchMap(`${preview.origin}/src/Card.tsx`, allowance)).resolves.toMatchObject({
      ok: true,
      value: { url: null, base: `${preview.origin}/src/v2/Card.tsx` },
    });
    expect(allowance.requests).toBe(2);
  });

  it("follows a redirect of the map itself and names the map where it landed", async () => {
    preview.routes.set("/a.js", body("x;\n//# sourceMappingURL=/a.js.map"));
    preview.routes.set("/a.js.map", redirect("/maps/a.js.map", 307));
    preview.routes.set("/maps/a.js.map", body(MAP));
    await expect(fetchMap(`${preview.origin}/a.js`)).resolves.toMatchObject({
      value: { url: `${preview.origin}/maps/a.js.map` },
    });
  });

  it("never follows a redirect off the preview origin", async () => {
    elsewhere.routes.set("/a.js", body(inline()));
    elsewhere.routes.set("/a.js.map", body(MAP));
    preview.routes.set("/a.js", redirect(`${elsewhere.origin}/a.js`));
    preview.routes.set("/b.js", body("x;\n//# sourceMappingURL=/b.js.map"));
    preview.routes.set("/b.js.map", redirect(`${elsewhere.origin}/a.js.map`));
    await expect(fetchMap(`${preview.origin}/a.js`)).resolves.toEqual({
      ok: false,
      reason: "outside-workspace",
    });
    await expect(fetchMap(`${preview.origin}/b.js`)).resolves.toEqual({
      ok: false,
      reason: "outside-workspace",
    });
    expect(elsewhere.hits).toEqual([]);
  });

  it("never fetches a module or map off the preview origin", async () => {
    elsewhere.routes.set("/a.js", body(inline()));
    elsewhere.routes.set("/a.js.map", body(MAP));
    preview.routes.set("/b.js", body(`x;\n//# sourceMappingURL=${elsewhere.origin}/a.js.map`));
    await expect(fetchMap(`${elsewhere.origin}/a.js`)).resolves.toEqual({
      ok: false,
      reason: "outside-workspace",
    });
    await expect(fetchMap(`${preview.origin}/b.js`)).resolves.toEqual({
      ok: false,
      reason: "outside-workspace",
    });
    await expect(fetchMap("file:///etc/passwd")).resolves.toEqual({
      ok: false,
      reason: "outside-workspace",
    });
    const withCredentials = preview.origin.replace("http://", "http://user:secret@");
    await expect(fetchMap(`${withCredentials}/b.js`)).resolves.toEqual({
      ok: false,
      reason: "outside-workspace",
    });
    expect(elsewhere.hits).toEqual([]);
    expect(preview.hits).toEqual(["/b.js"]);
  });

  it("gives up on a redirect loop after the cap, having paid for every hop", async () => {
    preview.routes.set("/loop.js", redirect("/loop.js"));
    const allowance = meter(64);
    await expect(fetchMap(`${preview.origin}/loop.js`, allowance)).resolves.toEqual({
      ok: false,
      reason: "map-missing",
    });
    expect(allowance.requests).toBe(MAX_SOURCE_MAP_REDIRECTS + 1);
  });

  it("reports a missing map as map-missing", async () => {
    preview.routes.set("/plain.js", body("export const a = 1;\n"));
    preview.routes.set("/gone.js", body("x;\n//# sourceMappingURL=/gone.js.map"));
    preview.routes.set(
      "/bad.js",
      body("x;\n//# sourceMappingURL=data:application/json;base64,@@@")
    );
    preview.routes.set("/html.js", body("x;\n//# sourceMappingURL=data:text/html,<p>"));
    for (const file of ["/plain.js", "/gone.js", "/bad.js", "/html.js", "/absent.js"]) {
      await expect(fetchMap(`${preview.origin}${file}`), file).resolves.toEqual({
        ok: false,
        reason: "map-missing",
      });
    }
  });

  it("charges every request and every byte, and stops at the allowance", async () => {
    preview.routes.set("/a.js", body("x;\n//# sourceMappingURL=/a.js.map"));
    preview.routes.set("/a.js.map", body(MAP));
    const spent = meter();
    await fetchMap(`${preview.origin}/a.js`, spent);
    const moduleBytes = Buffer.byteLength("x;\n//# sourceMappingURL=/a.js.map");
    expect(spent).toMatchObject({ requests: 2, received: moduleBytes + Buffer.byteLength(MAP) });

    await expect(fetchMap(`${preview.origin}/a.js`, meter(1))).resolves.toEqual({
      ok: false,
      reason: "budget-exhausted",
    });
    await expect(fetchMap(`${preview.origin}/a.js`, meter(8, moduleBytes + 4))).resolves.toEqual({
      ok: false,
      reason: "budget-exhausted",
    });
  });

  it("follows only real redirects: a 304 naming another module is not one", async () => {
    preview.routes.set("/a.js", (_request, response) =>
      response.writeHead(304, { location: "/other.js" }).end()
    );
    preview.routes.set("/other.js", body(inline()));
    await expect(fetchMap(`${preview.origin}/a.js`)).resolves.toEqual({
      ok: false,
      reason: "map-missing",
    });
    expect(preview.hits).toEqual(["/a.js"]);
  });

  it("keeps the bytes a cancelled read already moved charged to the job", async () => {
    const chunk = "x".repeat(1000);
    preview.routes.set("/partial.js", (_request, response) => {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.write(chunk);
    });
    const controller = new AbortController();
    const spent = meter();
    const pending = fetchMap(`${preview.origin}/partial.js`, spent, controller.signal);
    const settled = pending.then(
      () => "resolved",
      () => "rejected"
    );
    await expect.poll(() => spent.received).toBe(chunk.length);
    controller.abort();
    await expect(settled).resolves.toBe("rejected");
    expect(spent).toMatchObject({ requests: 1, received: chunk.length });
  });

  it("stops when the job is cancelled", async () => {
    preview.routes.set("/slow.js", () => undefined);
    const controller = new AbortController();
    const pending = fetchMap(`${preview.origin}/slow.js`, meter(), controller.signal);
    await expect.poll(() => preview.hits).toEqual(["/slow.js"]);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe("sourceMappingReference", () => {
  it("takes the last annotation in the comments that end the file", () => {
    expect(
      sourceMappingReference("a;\n//# sourceMappingURL=a.map\n//# sourceMappingURL=b.map\n")
    ).toBe("b.map");
    expect(sourceMappingReference("a;\r\n//@ sourceMappingURL=old.map\r\n")).toBe("old.map");
    expect(sourceMappingReference("a {}\n/*# sourceMappingURL=a.css.map */\n")).toBe("a.css.map");
    expect(sourceMappingReference("a;\n//# sourceMappingURL=a.map\n// trailing comment\n\n")).toBe(
      "a.map"
    );
    expect(sourceMappingReference("//# sourceMappingURL=only.map")).toBe("only.map");
    expect(sourceMappingReference("a;\n//# sourceMappingURL=a.map\n/* license */\n")).toBe("a.map");
  });

  it("ignores an annotation that code follows, or one inside the module's own text", () => {
    expect(sourceMappingReference("//# sourceMappingURL=a.map\nexport const a = 1;\n")).toBeNull();
    expect(sourceMappingReference('const s = "//# sourceMappingURL=a.map";\n')).toBeNull();
    expect(sourceMappingReference("x; //# sourceMappingURL=a.map")).toBeNull();
    expect(
      sourceMappingReference("//# sourceMappingURL=a.map\n/* a */ run(); /* b */\n")
    ).toBeNull();
    expect(sourceMappingReference("\n")).toBeNull();
    expect(sourceMappingReference("")).toBeNull();
  });
});

describe("decodeDataUrl", () => {
  it("refuses a media type that is not JSON", () => {
    expect(decodeDataUrl("data:text/html;base64,e30=")).toBeNull();
    expect(decodeDataUrl("data:application/json;base64,e30=")).toEqual(
      new TextEncoder().encode("{}")
    );
    expect(decodeDataUrl("data:,%7B%7D")).toEqual(new TextEncoder().encode("{}"));
    expect(decodeDataUrl("data:application/json;base64")).toBeNull();
  });
});
