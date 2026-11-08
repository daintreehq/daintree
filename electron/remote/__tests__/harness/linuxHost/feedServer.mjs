import { appendFileSync, createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { URL } from "node:url";

// The release feed a host fetches from, answering as updates.daintree.org over
// real TLS. Files are read per request, so a test can change what it serves.
const ROOT = "/feed/www";

// Seeded through `docker cp` once running; a seed that never comes ends the container.
const deadline = Date.now() + 5 * 60_000;
while (!existsSync("/feed/ready")) {
  if (Date.now() > deadline) process.exit(1);
  await sleep(100);
}

const server = https.createServer(
  { key: readFileSync("/feed/tls/feed.key"), cert: readFileSync("/feed/tls/feed.crt") },
  (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "https://feed").pathname);
    const file = path.join(ROOT, path.normalize(pathname));
    appendFileSync("/feed/requests.log", `${request.method} ${pathname}\n`);
    let size = -1;
    try {
      const stat = statSync(file);
      if (file.startsWith(`${ROOT}/`) && stat.isFile()) size = stat.size;
    } catch {
      // Answered below.
    }
    if (size < 0) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(size),
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(file).pipe(response);
  }
);
server.listen(443, "0.0.0.0");
