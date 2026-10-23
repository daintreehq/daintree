import { createHash } from "node:crypto";

/**
 * The one page a paired device loads. Everything it shows is set through
 * `textContent`, never parsed as markup, and the CSP allows only this exact
 * script and style, so screen text an agent drew can't run in the page. The
 * token sits in the device's own storage and travels only as a Bearer header,
 * which no other site can make the browser send.
 */
const SCRIPT = String.raw`
(() => {
  const KEY = "daintree-device-token";
  const POLL_MS = 3000;
  // An answer whose reply never arrived, or couldn't be read, may have gone in.
  const UNHEARD = "Couldn't hear back from Daintree. It may have been pressed, so check before answering again.";
  const $ = (id) => document.getElementById(id);
  let token = null;
  let timer = null;
  let busy = false;
  let polling = false;
  // Bumped when an answer starts: a list read before it is stale, and a card
  // stays pressed-out until a list read after it replaces it.
  let answerSeq = 0;
  // When the list last stopped coming back, and when each host that had been
  // read stopped being readable; both clear once they answer again.
  let downSince = 0;
  const hostRead = new Set();
  const hostDownSince = new Map();
  try { token = localStorage.getItem(KEY); } catch {}

  const save = (value) => {
    token = value;
    if (!value) {
      downSince = 0;
      hostRead.clear();
      hostDownSince.clear();
    }
    try { value ? localStorage.setItem(KEY, value) : localStorage.removeItem(KEY); } catch {}
  };

  const call = async (method, path, body) => {
    const headers = { "X-Daintree-Device": "1" };
    if (token) headers.Authorization = "Bearer " + token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
    });
    let data = null;
    try { data = await response.json(); } catch {}
    if (response.status === 401 && path !== "/api/pair") {
      save(null);
      show();
    }
    return { ok: response.ok, status: response.status, data };
  };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const ago = (since) => {
    if (!since) return "";
    const s = Math.max(0, Math.round((Date.now() - since) / 1000));
    if (s < 60) return s + "s";
    const m = Math.round(s / 60);
    return m < 60 ? m + " min" : Math.round(m / 60) + " h";
  };

  // The device's own clock, written the same everywhere rather than by locale.
  const clock = (ms) => {
    const at = new Date(ms);
    return String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0");
  };

  // Whole minutes, so the count reads the same way for the whole outage.
  const minutes = (since) => Math.max(0, Math.floor((Date.now() - since) / 60000)) + " min";

  // The cards stay to read, but a list that may be old can't be answered from.
  const markStale = () => {
    for (const card of $("runs").querySelectorAll(".run")) {
      card.classList.add("stale");
      for (const b of card.querySelectorAll("button")) b.disabled = true;
    }
  };

  const render = (runs, reported) => {
    const hosts = Array.isArray(reported)
      ? reported.filter((host) => host && typeof host.host === "string")
      : [];
    const list = $("runs");
    list.replaceChildren();
    const empty = $("empty");
    empty.hidden = runs.length > 0;
    // Nothing waiting is said outright only when every machine was read.
    const read = hosts.filter((host) => host.status === "ok").map((host) => host.host);
    const covered = ["this computer", ...read];
    empty.textContent = read.length === hosts.length
      ? "No agent is waiting."
      : "No agent is waiting on " + (covered.length > 1
        ? covered.slice(0, -1).join(", ") + " or " + covered[covered.length - 1]
        : covered[0]) + ".";
    const notes = $("hosts");
    notes.replaceChildren();
    const listed = new Set(hosts.map((host) => host.hostId || host.host));
    for (const key of [...hostRead]) if (!listed.has(key)) hostRead.delete(key);
    for (const key of [...hostDownSince.keys()]) if (!listed.has(key)) hostDownSince.delete(key);
    for (const host of hosts) {
      const key = host.hostId || host.host;
      if (host.status === "ok") {
        hostRead.add(key);
        hostDownSince.delete(key);
        continue;
      }
      if (host.status === "needs-update") {
        hostRead.delete(key);
        hostDownSince.delete(key);
        notes.append(el("div", "", host.host + " needs a newer Daintree to show its waiting agents here."));
        continue;
      }
      // Only a host seen answering has a time it stopped.
      if (hostRead.has(key) && !hostDownSince.has(key)) hostDownSince.set(key, Date.now());
      const since = hostDownSince.get(key);
      const at = since ? " since " + clock(since) : "";
      notes.append(el("div", "", host.status === "not-connected"
        ? "Not connected to " + host.host + at + ", so its agents aren't shown."
        : "Couldn't read the waiting agents on " + host.host + at + "."));
    }
    // Machines are named once there is more than one to tell apart.
    const named = hosts.length > 0;
    for (const run of runs) {
      const card = el("section", "run");
      const head = el("div", "head");
      head.append(el("strong", "", run.project || "Unknown project"));
      if (named && run.host) head.append(el("span", "host", run.host));
      if (run.title) head.append(el("span", "title", run.title));
      card.append(head);
      const state = [run.agentId, run.agentState, run.waitingReason].filter(Boolean).join(" · ");
      const meta = el("div", "meta", state + (run.since ? " · for " + ago(run.since) : ""));
      card.append(meta);
      card.append(el("pre", "screen", run.screen === null ? "Couldn't read this screen." : run.screen));
      const actions = el("div", "actions");
      if (run.choices.length === 0) {
        actions.append(el("span", "note", "No options to pick on this screen."));
      }
      for (const label of run.choices) {
        const button = el("button", "", label);
        button.type = "button";
        button.addEventListener("click", () => answer(run, label, card));
        actions.append(button);
      }
      card.append(actions);
      card.append(el("div", "result"));
      list.append(card);
    }
  };

  const answer = async (run, label, card) => {
    if (busy) return;
    busy = true;
    answerSeq += 1;
    for (const b of card.querySelectorAll("button")) b.disabled = true;
    const result = card.querySelector(".result");
    result.textContent = "Pressing…";
    try {
      const r = await call("POST", "/api/answer", {
        hostId: run.hostId,
        runId: run.runId,
        spawnedAt: run.spawnedAt,
        label,
      });
      result.textContent = r.ok ? "Picked “" + label + "”." : (r.data && r.data.error) || UNHEARD;
    } catch {
      // The request may have arrived before the reply was lost.
      result.textContent = UNHEARD;
    } finally {
      busy = false;
      setTimeout(poll, 600);
    }
  };

  const poll = async () => {
    if (polling) return;
    clearTimeout(timer);
    if (!token || document.visibilityState !== "visible") return;
    if (!busy) {
      polling = true;
      const seq = answerSeq;
      try {
        const r = await call("GET", "/api/waiting?hosts=1");
        if (busy || seq !== answerSeq) {
          // An answer began while this was in flight; the next read shows its result.
        } else if (r.ok && r.data) {
          downSince = 0;
          $("status").textContent = "";
          render(r.data.runs, r.data.hosts);
        } else if (r.status !== 401) {
          $("status").textContent = (r.data && r.data.error) || "Couldn't read the waiting agents.";
          markStale();
        }
      } catch {
        if (token && !busy && seq === answerSeq) {
          if (!downSince) downSince = Date.now();
          $("status").textContent = "Couldn't reach Daintree since " + clock(downSince) + " (" + minutes(downSince) + ").";
          markStale();
        }
      } finally {
        polling = false;
      }
    }
    if (token) timer = setTimeout(poll, POLL_MS);
  };

  const show = () => {
    $("pair").hidden = !!token;
    $("main").hidden = !token;
    if (token) poll();
  };

  $("pair-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("pair-error").textContent = "";
    const code = $("code").value;
    const name = $("name").value.trim() || "Unnamed device";
    try {
      const r = await call("POST", "/api/pair", { code, deviceName: name });
      if (r.ok && r.data && r.data.token) {
        save(r.data.token);
        $("code").value = "";
        show();
      } else {
        $("pair-error").textContent = (r.data && r.data.error) || "That code didn't work.";
      }
    } catch {
      $("pair-error").textContent = "Couldn't reach Daintree.";
    }
  });

  $("forget").addEventListener("click", async () => {
    // Removed on the computer too, not just forgotten here.
    try { await call("POST", "/api/unpair", {}); } catch {}
    save(null);
    show();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") poll();
  });

  show();
})();
`;

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1c1c1a; --muted: #6b6b66; --card: #ffffff; --line: #deded8; --screen: #f0f0ec; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ececea; --muted: #9a9a94; --card: #1f1f1d; --line: #33332f; --screen: #121211; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main, #pair { max-width: 720px; margin: 0 auto; }
h1 { font-size: 18px; margin: 0 0 12px; }
p { color: var(--muted); margin: 0 0 12px; }
label { display: block; margin: 12px 0 4px; font-weight: 600; }
input { width: 100%; padding: 10px; font: inherit; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--fg); }
button { font: inherit; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); }
button:disabled { opacity: 0.5; }
form button { margin-top: 16px; width: 100%; }
.run.stale .screen { opacity: 0.6; }
.run { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin: 0 0 12px; }
.head { display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; }
.title, .host, .meta, .note, .result, #status, #hosts, #empty { color: var(--muted); font-size: 13px; }
.screen { background: var(--screen); border-radius: 6px; padding: 8px; margin: 8px 0; font: 12px/1.35 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-word; max-height: 40vh; overflow: auto; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.result { margin-top: 8px; min-height: 1em; }
.error { color: #c0392b; font-size: 13px; min-height: 1em; margin-top: 8px; }
.bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
`;

function sha256Base64(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("base64");
}

export const DEVICE_PAGE_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${sha256Base64(SCRIPT)}'`,
  `style-src 'sha256-${sha256Base64(STYLE)}'`,
  "connect-src 'self'",
  "img-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const DEVICE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Daintree</title>
<style>${STYLE}</style>
</head>
<body>
<div id="pair" hidden>
  <h1>Pair with Daintree</h1>
  <p>Pairing lets this device see the screens of agents waiting on that computer, and on the hosts it's connected to, and pick the options they show. It can't type, start agents or read anything else. You can remove it any time in Daintree's settings.</p>
  <form id="pair-form" autocomplete="off">
    <label for="code">Pairing code</label>
    <input id="code" inputmode="text" autocapitalize="characters" spellcheck="false" maxlength="16" required>
    <label for="name">Name for this device</label>
    <input id="name" maxlength="60" placeholder="My phone">
    <button type="submit">Pair</button>
    <div id="pair-error" class="error" role="alert"></div>
  </form>
</div>
<main id="main" hidden>
  <div class="bar"><h1>Waiting agents</h1><button id="forget" type="button">Unpair</button></div>
  <div id="status" role="status"></div>
  <div id="hosts"></div>
  <div id="empty" hidden>No agent is waiting.</div>
  <div id="runs"></div>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
