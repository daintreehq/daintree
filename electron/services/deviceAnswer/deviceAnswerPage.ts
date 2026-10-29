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
  // An answered card stays as a receipt this long after its run stops being listed.
  const RECEIPT_MS = 2 * 60000;
  // An answer whose reply never arrived, or couldn't be read, may have gone in.
  const UNHEARD = "Couldn't hear back from Daintree. It may have been pressed, so check before answering again.";
  const $ = (id) => document.getElementById(id);
  // A reply slower than this is treated as lost: a press may or may not have gone in.
  const ANSWER_TIMEOUT_MS = 20000;
  // Every other request gives up sooner, so nothing waits on a dead tunnel for ever.
  const REQUEST_TIMEOUT_MS = 12000;
  // Under this, a wait shows nothing; past it, it says what it's waiting for.
  const GATE_MS = 400;
  let token = null;
  let timer = null;
  let polling = false;
  // Asked for while a read was already in flight, so another follows it at once.
  let again = false;
  // Bumped when an answer starts or the page comes back: a list read begun
  // before either may show what's no longer there.
  let epoch = 0;
  let gate = null;
  let gateOpen = false;
  // When the list last stopped coming back, and when each host that had been
  // read stopped being readable; both clear once they answer again.
  let downSince = 0;
  // When the host list itself last stopped being readable.
  let hostsDownSince = 0;
  const hostRead = new Set();
  const hostDownSince = new Map();
  // When the list was last read whole, and whether what's on screen may be older than that.
  let readAt = 0;
  let freshness = "fresh";
  let computer = null;
  // One entry per card on screen, by machine, run and spawn, so a read patches
  // what changed instead of rebuilding, and an answer's outcome outlives the poll.
  const cards = new Map();
  let cardIds = 0;
  try { token = localStorage.getItem(KEY); } catch {}

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const setText = (node, text) => {
    if (node.textContent !== text) node.textContent = text;
  };

  const show = (node, visible) => {
    if (node.hidden === visible) node.hidden = !visible;
  };

  // The device's own clock, written the same everywhere rather than by locale.
  const clock = (ms) => {
    const at = new Date(ms);
    return String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0");
  };

  // Whole minutes, so the count reads the same way for the whole outage.
  const minutes = (since) => Math.max(0, Math.floor((Date.now() - since) / 60000)) + " min";

  const waited = (since) => {
    const m = Math.floor(Math.max(0, Date.now() - since) / 60000);
    if (m < 1) return "under 1 min";
    if (m < 60) return m + " min";
    const h = Math.floor(m / 60);
    return h < 24 ? h + " h" : Math.floor(h / 24) + " d";
  };

  // The app's own words for what was observed (shared/utils/waitingReasonDisplay.ts).
  const HEADLINES = {
    approval: "Waiting for approval",
    question: "Asked a question",
    error: "Blocked by an error",
  };
  const headline = (run) => HEADLINES[run.waitingReason] || "Waiting for input";

  const agentName = (run) => {
    if (run.agentName) return run.agentName;
    const id = run.agentId || "";
    return id ? id.charAt(0).toUpperCase() + id.slice(1) : "";
  };

  const listOf = (names) =>
    names.length > 1 ? names.slice(0, -1).join(", ") + " or " + names[names.length - 1] : names[0];

  const here = () => computer || "this computer";

  // Rows as drawn, without the padding a terminal fills its width with or the
  // blank rows under the last thing on screen.
  const tidy = (screen) => screen.replace(/[ \t]+$/gm, "").replace(/\s+$/, "");

  const keyOf = (run) => [run.hostId || "", run.runId, run.spawnedAt].join("\u0000");

  const announce = (text) => {
    const live = $("announce");
    live.textContent = "";
    setTimeout(() => { live.textContent = text; }, 50);
  };

  const save = (value) => {
    token = value;
    if (!value) {
      // Nothing read under the old pairing is offered under the next one.
      downSince = 0;
      hostsDownSince = 0;
      readAt = 0;
      freshness = "fresh";
      computer = null;
      hostRead.clear();
      hostDownSince.clear();
      hostsSaid = null;
      cards.clear();
      $("runs").replaceChildren();
      $("hosts").replaceChildren();
      $("empty").hidden = true;
      $("status").textContent = "";
      $("updated").textContent = "";
      $("unpair-error").textContent = "";
    }
    try { value ? localStorage.setItem(KEY, value) : localStorage.removeItem(KEY); } catch {}
  };

  const call = async (method, path, body, limit = REQUEST_TIMEOUT_MS) => {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), limit);
    try {
      return await send(method, path, body, abort.signal);
    } finally {
      clearTimeout(timeout);
    }
  };

  const send = async (method, path, body, signal) => {
    const headers = { "X-Daintree-Device": "1" };
    if (token) headers.Authorization = "Bearer " + token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      signal,
    });
    let data = null;
    try { data = await response.json(); } catch {}
    if (response.status === 401 && path !== "/api/pair") {
      // The computer no longer knows this device; say so on the form it lands on.
      const ended = !!token;
      save(null);
      showPage();
      if (ended) {
        $("pair-ended").hidden = false;
        announce($("pair-ended").textContent);
      }
    }
    return { ok: response.ok, status: response.status, data };
  };

  // A card is offered only from a list read whole, and never mid-press.
  const refreshCard = (entry) => {
    const old = freshness !== "fresh";
    // A check that lands inside the gate never shows; the options are held either way.
    const said = freshness === "stale" || (freshness === "checking" && gateOpen);
    entry.card.classList.toggle("stale", said);
    setText(entry.fresh, !said ? ""
      : "Not current: last read " + clock(readAt) + "." + (freshness === "checking" ? " Checking now…" : ""));
    show(entry.fresh, said);
    // Mid-press, or just refused or unheard: nothing more until a fresh read shows the screen.
    const pressing = !!entry.state && entry.state.kind === "pressing";
    const locked = old || pressing || (!!entry.state && entry.state.waiting === true);
    for (const b of entry.actions.querySelectorAll("button")) {
      b.disabled = locked;
      b.classList.toggle("picked", pressing && b.textContent === entry.state.label);
    }
  };

  const setFreshness = (next) => {
    freshness = next;
    clearTimeout(gate);
    gateOpen = false;
    if (next === "checking") {
      gate = setTimeout(() => {
        gateOpen = true;
        if (freshness === "checking") setFreshness("checking-shown");
      }, GATE_MS);
    }
    if (next === "checking-shown") {
      freshness = "checking";
      gateOpen = true;
      announce("Checking for changes. The agents shown may not be current.");
    }
    for (const entry of cards.values()) refreshCard(entry);
    updateHeader();
    refreshEmpty();
  };

  // An empty result is an observation with a time, and says so once it may be old.
  const refreshEmpty = () => {
    const said = freshness === "stale" || (freshness === "checking" && gateOpen);
    setText($("empty-checked"), !readAt ? ""
      : !said ? "Checked at " + clock(readAt) + ", and every few seconds while this page is open."
      : "Not current: last checked " + clock(readAt) + "." + (freshness === "checking" ? " Checking now…" : ""));
  };

  const updateHeader = () => {
    const where = computer ? "Daintree on " + computer : "Daintree";
    const waiting = [...cards.values()].filter((entry) => !entry.card.classList.contains("gone")).length;
    setText($("count"), waiting > 0 ? String(waiting) : "");
    // A failed read takes the line the read time sits on, so the header stays one line tall.
    const failing = $("status").textContent !== "";
    show($("status"), failing);
    show($("updated"), !failing);
    const checking = freshness === "checking" && gateOpen;
    const when = !readAt ? (checking ? "checking for waiting agents…" : "")
      : (freshness === "fresh" ? "updated " : "last read ") + clock(readAt) + (checking ? ", checking now…" : "");
    const line = [computer || "", when].filter(Boolean).join(" · ");
    setText($("updated"), line.charAt(0).toUpperCase() + line.slice(1));
    setText($("paired-with"), "This device is paired with " + where + ".");
  };

  const makeCard = (key) => {
    const card = el("section", "run");
    const id = "run-" + (cardIds += 1);
    const head = el("div", "head");
    const project = el("h2", "project");
    project.id = id;
    project.tabIndex = -1;
    const tags = el("span", "tags");
    head.append(project, tags);
    const title = el("div", "title");
    const where = el("div", "where");
    const meta = el("div", "meta");
    const fresh = el("div", "fresh");
    fresh.hidden = true;
    const screen = el("pre", "screen");
    screen.tabIndex = 0;
    const unread = el("div", "unread");
    unread.hidden = true;
    // What came of an answer, next to the options it was picked from.
    const result = el("div", "result");
    result.hidden = true;
    const actions = el("div", "actions");
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-labelledby", id);
    card.setAttribute("aria-labelledby", id);
    card.append(head, title, where, meta, fresh, screen, unread, result, actions);
    return {
      key, card, where, project, tags, title, meta, fresh, screen, unread, result, actions,
      run: null, screenText: null, choices: null, state: null,
    };
  };

  // Content about to go away never takes focus with it: it moves to the card's heading.
  const keepFocus = (entry, within = entry.card) => {
    const active = document.activeElement;
    if (active && active !== entry.project && within.contains(active)) entry.project.focus();
  };

  const showResult = (entry) => {
    const state = entry.state;
    const box = entry.result;
    box.className = "result" + (state ? " " + state.kind : "");
    const collapsed = !!state && state.collapsed === true;
    if (collapsed) keepFocus(entry);
    entry.card.classList.toggle("answered", collapsed);
    if (!state) {
      show(box, false);
      setText(box, "");
      box.dataset.said = "";
      return;
    }
    const picked = "“" + state.label + "”";
    // A refusal's own words say whether anything went in; the heading never does.
    const lines = {
      pressing: state.shown ? ["Pressing " + picked + "…"] : [],
      answered: ["Answered " + picked + " · " + clock(state.at)],
      earlier: ["Answered " + picked + " at " + clock(state.at) + ". The screen has changed since."],
      refused: ["Couldn't complete " + picked, state.reason],
      unheard: ["No reply after " + picked + " at " + clock(state.at), UNHEARD],
    }[state.kind];
    if ((state.kind === "unheard" || state.kind === "refused") && state.collapsed) {
      lines.push("It isn't listed as waiting any more.");
    }
    const said = lines.join("\n");
    if (box.dataset.said !== said) {
      box.dataset.said = said;
      box.replaceChildren(...lines.map((line, i) => el(i === 0 && lines.length > 1 ? "strong" : "span", "", line)));
    }
    show(box, lines.length > 0);
  };

  const fillChoices = (entry, run) => {
    const elsewhere = "Answer it in Daintree on " + (run.host || here()) + ".";
    const choices = run.screen === null ? "\u0001" : run.choices.join("\u0000");
    setText(entry.unread, "Couldn't read this screen, so it can't be answered from here. " + elsewhere);
    if (choices === entry.choices) return;
    entry.choices = choices;
    keepFocus(entry, entry.actions);
    // The options carry their label alone; the screen's own numbering is drawn
    // beside them by the stylesheet, so a button maps to the row it presses.
    const buttons = run.screen === null ? [] : run.choices.map((label) => {
      const button = el("button", "option", label);
      button.type = "button";
      button.addEventListener("click", () => answer(entry, label));
      return button;
    });
    if (buttons.length === 0 && run.screen !== null) {
      entry.actions.replaceChildren(el("p", "none", "No options found on this screen. " + elsewhere));
    } else {
      entry.actions.replaceChildren(...buttons);
    }
  };

  const fillScreen = (entry, run) => {
    const text = run.screen === null ? null : tidy(run.screen);
    if (text === null) keepFocus(entry, entry.screen);
    show(entry.screen, text !== null);
    show(entry.unread, text === null);
    if (text === null || text === entry.screenText) {
      entry.screenText = text;
      return;
    }
    const pre = entry.screen;
    // Pinned to the bottom, where the prompt is, unless the user scrolled up to read.
    const pinned = entry.screenText === null || pre.scrollHeight - pre.scrollTop - pre.clientHeight < 8;
    const left = pre.scrollLeft;
    const top = pre.scrollTop;
    pre.textContent = text;
    entry.screenText = text;
    entry.pin = pinned;
    if (!pinned) pre.scrollTop = top;
    pre.scrollLeft = left;
  };

  const fill = (entry, run) => {
    entry.run = run;
    const agent = agentName(run);
    const where = [run.host || "", agent].filter(Boolean).join(" · ");
    if (entry.where.textContent !== where) {
      // The agent's name travels with its separator, so a long machine name never strands it.
      entry.where.replaceChildren(...(run.host && agent
        ? [run.host + " ", el("span", "nowrap", "· " + agent)]
        : [where]));
    }
    show(entry.where, where !== "");
    setText(entry.project, run.project || "Unknown project");
    const tags = [run.parked ? "Parked" : "", run.snoozed ? "Snoozed" : ""].filter(Boolean);
    if (entry.tags.textContent !== tags.join("")) entry.tags.replaceChildren(...tags.map((t) => el("span", "tag", t)));
    setText(entry.title, run.title || "");
    show(entry.title, !!run.title);
    setText(entry.meta, headline(run) + (run.since ? " · " + waited(run.since) : ""));
    entry.screen.setAttribute("aria-label", "Screen of " + (run.project || "this agent"));
    fillScreen(entry, run);
    fillChoices(entry, run);
    const state = entry.state;
    if (state) state.waiting = false;
    // Only a screen that was read, and reads differently, retires what came of the last answer.
    const fresh = run.screen !== null && entry.screenText !== state?.screen;
    if (state && (state.kind === "answered" || state.kind === "refused" || state.kind === "unheard") && fresh) {
      // A fresh screen: what came of the last answer no longer describes it.
      entry.state = state.kind === "answered" ? { ...state, kind: "earlier", collapsed: false } : null;
    } else if (state && state.kind === "answered") {
      state.collapsed = true;
    }
    showResult(entry);
    refreshCard(entry);
  };

  const removeCard = (entry) => {
    const card = entry.card;
    if (card.contains(document.activeElement)) {
      // Focus goes to the next card, or the page heading, never to the void.
      const next = card.nextElementSibling || card.previousElementSibling;
      const target = next ? next.querySelector(".project") : $("title");
      if (target) target.focus();
    }
    card.remove();
    cards.delete(entry.key);
  };

  // What the host notes last said, so a change in coverage is announced once.
  let hostsSaid = null;

  const renderHosts = (hosts, unlisted) => {
    // Each note is [before, machine, after], so the machine can be picked out
    // without changing the sentence.
    const notes = [];
    if (unlisted) {
      if (!hostsDownSince) hostsDownSince = Date.now();
      notes.push(["Couldn't list the connected hosts since " + clock(hostsDownSince) + ", so their agents aren't shown.", "", ""]);
    } else {
      hostsDownSince = 0;
    }
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
        notes.push(["", host.host, " needs a newer Daintree to show its waiting agents here."]);
        continue;
      }
      // Only a host seen answering has a time it stopped.
      if (hostRead.has(key) && !hostDownSince.has(key)) hostDownSince.set(key, Date.now());
      const since = hostDownSince.get(key);
      const at = since ? " since " + clock(since) : "";
      notes.push(host.status === "not-connected"
        ? ["Not connected to ", host.host, at + ", so its agents aren't shown."]
        : ["Couldn't read the waiting agents on ", host.host, at + "."]);
    }
    const box = $("hosts");
    if (box.textContent !== notes.map((note) => note.join("")).join("")) {
      box.replaceChildren(...notes.map(([before, name, after]) => {
        const item = el("li");
        item.append(before, ...(name ? [el("strong", "", name)] : []), after);
        return item;
      }));
    }
    box.hidden = notes.length === 0;
    const said = notes.map((note) => note.join("")).join(" ");
    if (hostsSaid !== null && said !== hostsSaid && said) announce(said);
    hostsSaid = said;
  };

  const render = (data) => {
    const runs = Array.isArray(data.runs) ? data.runs : [];
    const hosts = Array.isArray(data.hosts)
      ? data.hosts.filter((host) => host && typeof host.host === "string")
      : [];
    if (typeof data.computer === "string" && data.computer) computer = data.computer;
    if (freshness === "checking" && gateOpen && readAt) announce("Up to date.");
    readAt = Date.now();
    freshness = "fresh";
    clearTimeout(gate);
    gateOpen = false;
    renderHosts(hosts, data.hostsUnlisted === true);
    const list = $("runs");
    const seen = new Set(runs.map(keyOf));
    for (const entry of cards.values()) entry.card.classList.toggle("gone", !seen.has(entry.key));
    let prev = null;
    for (const run of runs) {
      const key = keyOf(run);
      let entry = cards.get(key);
      if (!entry) {
        entry = makeCard(key);
        cards.set(key, entry);
      }
      fill(entry, run);
      // Listed cards keep the server's order; a receipt for a run that left
      // the list holds the place it had.
      let next = prev ? prev.nextSibling : list.firstChild;
      while (next && next !== entry.card && next.classList.contains("gone")) next = next.nextSibling;
      if (next !== entry.card) list.insertBefore(entry.card, next);
      prev = entry.card;
    }
    for (const entry of [...cards.values()]) {
      if (seen.has(entry.key)) continue;
      const state = entry.state;
      const held = state && state.kind !== "earlier" && Date.now() - state.at < RECEIPT_MS;
      if (!held) {
        removeCard(entry);
        continue;
      }
      if (state.kind !== "pressing") state.collapsed = true;
      showResult(entry);
      refreshCard(entry);
    }
    // A new or grown screen opens at its bottom, where the prompt is; this
    // needs the card laid out, so it runs once every card is in place.
    for (const entry of cards.values()) {
      if (entry.pin) entry.screen.scrollTop = entry.screen.scrollHeight;
      entry.pin = false;
    }
    // Only machines that were read are said to have nothing waiting.
    $("empty").hidden = runs.length > 0;
    const read = hosts.filter((host) => host.status === "ok").map((host) => host.host);
    setText($("empty-covered"), "No agent is waiting on " + listOf([here(), ...read]) + ".");
    refreshEmpty();
    updateHeader();
  };

  const answer = async (entry, label) => {
    if (freshness !== "fresh" || (entry.state && entry.state.kind === "pressing")) return;
    const run = entry.run;
    epoch += 1;
    entry.state = { kind: "pressing", label, at: Date.now(), screen: entry.screenText };
    showResult(entry);
    refreshCard(entry);
    const session = token;
    const slow = setTimeout(() => {
      if (entry.state && entry.state.kind === "pressing") {
        entry.state.shown = true;
        showResult(entry);
        announce((run.project || "Agent") + ": " + entry.result.textContent);
      }
    }, GATE_MS);
    let next;
    try {
      const r = await call("POST", "/api/answer", {
        hostId: run.hostId,
        runId: run.runId,
        spawnedAt: run.spawnedAt,
        label,
      }, ANSWER_TIMEOUT_MS);
      if (r.status === 401) return;
      next = r.ok
        ? { kind: "answered", collapsed: true }
        : r.data && r.data.error
          ? { kind: "refused", reason: r.data.error, waiting: true }
          : { kind: "unheard", waiting: true };
    } catch {
      // The request may have arrived before the reply was lost or ran out of time.
      next = { kind: "unheard", waiting: true };
    } finally {
      clearTimeout(slow);
    }
    if (token !== session || cards.get(entry.key) !== entry) return;
    entry.state = { label, at: entry.state.at, screen: entry.state.screen, ...next };
    showResult(entry);
    refreshCard(entry);
    announce((entry.run.project || "Agent") + ": " + entry.result.textContent);
    setTimeout(poll, 600);
  };

  const failed = (text, quiet) => {
    setText($("status"), text);
    if (freshness !== "stale" && !quiet) announce(text + " The agents shown may not be current.");
    if (freshness !== "stale") setFreshness("stale");
    else updateHeader();
  };

  const poll = async () => {
    if (polling) {
      again = true;
      return;
    }
    clearTimeout(timer);
    if (!token || document.visibilityState !== "visible") return;
    polling = true;
    again = false;
    const seq = epoch;
    const session = token;
    try {
      const r = await call("GET", "/api/waiting?hosts=1");
      if (token !== session) {
        // Unpaired while this was in flight; it belongs to the old pairing.
      } else if (r.ok && r.data) {
        // A read begun before an answer or a return may show what's gone; the next one won't.
        if (seq === epoch) {
          if (downSince || $("status").textContent) announce("Back in touch with Daintree.");
          downSince = 0;
          $("status").textContent = "";
          render(r.data);
        } else {
          again = true;
        }
      } else if (r.status !== 401) {
        // A failed read still means the cards on screen may be old, answer or not.
        failed((r.data && r.data.error) || "Couldn't read the waiting agents.");
      }
    } catch {
      if (token === session) {
        const first = !downSince;
        if (first) downSince = Date.now();
        failed("Couldn't reach Daintree since " + clock(downSince) + " (" + minutes(downSince) + ").", !first);
      }
    } finally {
      polling = false;
    }
    if (token) timer = setTimeout(poll, again ? 0 : POLL_MS);
  };

  // Which view is up, so focus moves only when the view actually changes.
  let view = null;

  const showPage = () => {
    $("pair").hidden = !!token;
    $("main").hidden = !token;
    const next = token ? "main" : "pair";
    if (view !== null && view !== next) $(token ? "title" : "pair-title").focus();
    view = next;
    if (token) {
      $("pair-ended").hidden = true;
      if (!readAt) setFreshness("checking");
      poll();
    } else {
      clearTimeout(timer);
    }
  };

  // Cards read before the phone slept are kept to look at, not to answer,
  // until the read the return starts lands.
  const resumed = () => {
    if (!token) return;
    if (document.visibilityState !== "visible") {
      // Held from the moment the page goes away, so nothing old is live on the way back.
      epoch += 1;
      if (freshness === "fresh") setFreshness("checking");
      return;
    }
    epoch += 1;
    // The gate restarts on return, so a read that lands at once never flashes a notice.
    if (freshness !== "stale") setFreshness("checking");
    poll();
  };
  document.addEventListener("visibilitychange", resumed);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) resumed();
  });

  // The address this page came from is what a code pairs with; a loopback
  // tunnel says nothing worth naming.
  const origin = location.hostname;
  if (origin && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(origin)) {
    $("pair-target").textContent = "At " + location.host;
    $("pair-target").hidden = false;
  }

  $("pair-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $("pair-submit");
    if (submit.disabled) return;
    $("pair-error").textContent = "";
    const code = $("code").value;
    const name = $("name").value.trim() || "Unnamed device";
    submit.disabled = true;
    submit.setAttribute("aria-busy", "true");
    $("code").readOnly = true;
    $("name").readOnly = true;
    $("code").removeAttribute("aria-invalid");
    const slow = setTimeout(() => { submit.textContent = "Pairing…"; }, GATE_MS);
    try {
      const r = await call("POST", "/api/pair", { code, deviceName: name });
      if (r.ok && r.data && r.data.token) {
        save(r.data.token);
        $("code").value = "";
        showPage();
      } else {
        $("pair-error").textContent = (r.data && r.data.error) || "That code didn't work.";
        $("code").setAttribute("aria-invalid", "true");
      }
    } catch {
      $("pair-error").textContent = "Couldn't reach Daintree. Check the tunnel to the computer is open, then try again.";
    } finally {
      clearTimeout(slow);
      $("code").readOnly = false;
      $("name").readOnly = false;
      submit.disabled = false;
      submit.removeAttribute("aria-busy");
      submit.textContent = "Pair";
    }
  });

  // A browser without a modal dialog still shows it, just without the backdrop.
  const dialog = $("unpair-dialog");
  const closeDialog = () => {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  };
  $("forget").addEventListener("click", () => {
    $("unpair-error").textContent = "";
    setText($("unpair-where"), here());
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    $("unpair-cancel").focus();
  });
  $("unpair-cancel").addEventListener("click", closeDialog);

  $("unpair-confirm").addEventListener("click", async () => {
    const confirm = $("unpair-confirm");
    confirm.disabled = true;
    const slow = setTimeout(() => { confirm.textContent = "Unpairing…"; }, GATE_MS);
    let done = false;
    try {
      // Removed on the computer too, not just forgotten here.
      const r = await call("POST", "/api/unpair", {});
      done = r.ok || r.status === 401;
      if (!done) {
        $("unpair-error").textContent = "Couldn't unpair: " + ((r.data && r.data.error) || "Daintree refused.") + " This device is still paired.";
      }
    } catch {
      $("unpair-error").textContent = "Couldn't confirm unpairing. Daintree didn't answer, so this device may still be paired. Try again, or remove it in Daintree → Settings → Hosts.";
    } finally {
      clearTimeout(slow);
      confirm.disabled = false;
      confirm.textContent = "Unpair device";
    }
    // On failure the dialog stays open, with what happened and the same choice to try again.
    if (done) {
      if (dialog.hasAttribute("open")) closeDialog();
      if (token) {
        const from = here();
        save(null);
        showPage();
        announce("Unpaired. This device was removed from Daintree on " + from + ".");
      }
    }
  });
  showPage();
})();
`;

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f4f4f1; --fg: #1b1b19; --muted: #5d5d58; --card: #ffffff; --line: #dcdcd6; --edge: #8c8c85;
  --screen: #f1f1ed; --screen-fg: #26261f; --press: #ebebe6;
  --warn-bg: #fcf3dc; --warn-fg: #5c4100; --warn-line: #e3c97c;
  --bad-bg: #fbeaea; --bad-fg: #9d1c1c; --bad-line: #e8b4b4;
  --cta-bg: #1b1b19; --cta-fg: #ffffff; --shade: rgba(0, 0, 0, 0.16);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131312; --fg: #ededea; --muted: #a6a6a0; --card: #1d1d1b; --line: #33332f; --edge: #77776f;
    --screen: #0d0d0c; --screen-fg: #e4e4df; --press: #2a2a27;
    --warn-bg: #2b2412; --warn-fg: #f2d68e; --warn-line: #5e4c1f;
    --bad-bg: #321a19; --bad-fg: #ff9d94; --bad-line: #6a2f2b;
    --cta-bg: #ededea; --cta-fg: #131312; --shade: rgba(255, 255, 255, 0.16);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
[hidden] { display: none !important; }
.wrap { max-width: 640px; margin: 0 auto; padding: 0 16px; }
h1 { font-size: 20px; line-height: 1.25; margin: 0; }
h1:focus:not(:focus-visible), .project:focus:not(:focus-visible) { outline: none; }
h1:focus-visible, .project:focus-visible { outline: 2px solid var(--fg); outline-offset: 3px; border-radius: 4px; }
p, li, .title, .fresh, .result, .where, .meta { text-wrap: pretty; }
button { font: inherit; color: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
button:focus-visible, input:focus-visible, .screen:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
button:disabled { cursor: default; }
.sr { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

#pair { padding-top: 32px; padding-bottom: 40px; }
#pair h1 { font-size: 24px; }
.target { margin: 4px 0 0; color: var(--muted); font-size: 15px; overflow-wrap: anywhere; }
.lede { margin: 12px 0 20px; color: var(--muted); }
label { display: block; margin: 20px 0 6px; font-weight: 600; }
.hint { margin: -2px 0 8px; color: var(--muted); font-size: 14px; }
input { width: 100%; min-height: 48px; padding: 10px 12px; font: inherit; font-size: 17px; border: 1px solid var(--edge); border-radius: 10px; background: var(--card); color: var(--fg); }
input::placeholder { color: var(--muted); opacity: 1; }
#code { font: 600 22px/1.2 ui-monospace, Menlo, monospace; letter-spacing: 0.12em; text-transform: uppercase; }
input[aria-invalid="true"] { border-color: var(--bad-fg); }
input:read-only { color: var(--muted); }
.primary { display: block; width: 100%; min-height: 50px; margin-top: 24px; padding: 12px 16px; border: 0; border-radius: 10px; background: var(--cta-bg); color: var(--cta-fg); font-weight: 600; }
.primary:disabled { opacity: 0.65; }
.notice { margin: 16px 0 0; padding: 12px 14px; border: 1px solid var(--warn-line); border-radius: 10px; background: var(--warn-bg); color: var(--warn-fg); font-size: 15px; }
.error { margin: 12px 0 0; color: var(--bad-fg); font-size: 15px; font-weight: 500; }
.error:empty { display: none; }
.small { margin: 24px 0 0; color: var(--muted); font-size: 14px; }

.top { position: sticky; top: 0; z-index: 1; background: var(--bg); border-bottom: 1px solid var(--line); }
.top .wrap { padding-top: 12px; padding-bottom: 10px; }
#updated { margin: 2px 0 0; color: var(--muted); font-size: 14px; overflow-wrap: anywhere; }
#status { margin: 2px 0 0; color: var(--warn-fg); font-size: 14px; font-weight: 600; }
.nowrap { white-space: nowrap; }
#hosts { list-style: none; margin: 16px 0 0; padding: 4px 14px; border: 1px solid var(--warn-line); border-radius: 10px; background: var(--warn-bg); color: var(--warn-fg); font-size: 14px; }
#hosts li { padding: 8px 0; overflow-wrap: anywhere; }
#hosts li + li { border-top: 1px solid var(--warn-line); }
#empty { margin: 48px 0 40px; text-align: center; }
#empty-covered { margin: 0; font-size: 17px; font-weight: 600; overflow-wrap: anywhere; }
#empty-checked { margin: 6px 0 0; color: var(--muted); font-size: 14px; }
.count { margin-left: 4px; padding: 0 8px; border-radius: 999px; background: var(--press); color: var(--fg); font-size: 15px; font-weight: 600; vertical-align: 2px; }
.count:empty { display: none; }
#runs { padding-top: 16px; }

.run { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 14px 16px; margin: 0 0 16px; scroll-margin-top: 96px; }
.head { display: flex; align-items: baseline; gap: 8px; }
.project { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 17px; line-height: 1.4; overflow-wrap: anywhere; }
.where { margin-top: 6px; color: var(--muted); font-size: 14px; line-height: 1.4; overflow-wrap: anywhere; }
.tags { display: flex; gap: 6px; flex: none; }
.tag { padding: 1px 8px; border: 1px solid var(--edge); border-radius: 999px; color: var(--muted); font-size: 12px; font-weight: 600; line-height: 1.5; }
.title { margin-top: 2px; font-size: 16px; line-height: 1.4; overflow-wrap: anywhere; }
.meta { color: var(--muted); font-size: 14px; line-height: 1.4; }
.fresh { margin-top: 10px; padding: 8px 12px; border: 1px solid var(--warn-line); border-radius: 8px; background: var(--warn-bg); color: var(--warn-fg); font-size: 14px; font-weight: 500; }
.screen {
  margin: 12px 0 0; padding: 10px 12px; max-height: min(40vh, 24em); overflow: auto; overscroll-behavior: contain;
  color: var(--screen-fg); border-radius: 8px; font: 13px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre; tab-size: 8; font-variant-ligatures: none; -webkit-overflow-scrolling: touch;
  /* Edge shadows where more of the screen is out of view; each is covered once its edge is reached. */
  background:
    linear-gradient(to right, var(--screen) 40%, transparent) left / 24px 100% no-repeat local,
    linear-gradient(to left, var(--screen) 40%, transparent) right / 24px 100% no-repeat local,
    linear-gradient(var(--screen) 40%, transparent) top / 100% 24px no-repeat local,
    linear-gradient(to right, var(--shade), transparent) left / 10px 100% no-repeat scroll,
    linear-gradient(to left, var(--shade), transparent) right / 10px 100% no-repeat scroll,
    linear-gradient(var(--shade), transparent) top / 100% 8px no-repeat scroll,
    var(--screen);
}
.unread { margin: 12px 0 0; padding: 12px; background: var(--screen); border-radius: 8px; color: var(--fg); font-size: 14px; }
.actions { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; counter-reset: option; }
.actions:empty { display: none; }
.option { position: relative; display: block; width: 100%; min-height: 48px; padding: 12px 14px 12px 40px; text-align: left; background: var(--card); border: 1px solid var(--edge); border-radius: 10px; line-height: 1.4; overflow-wrap: anywhere; }
.option::before { counter-increment: option; content: counter(option); position: absolute; left: 14px; top: 12px; color: var(--muted); font-weight: 600; font-variant-numeric: tabular-nums; }
.option:active:not(:disabled) { background: var(--press); }
.option:disabled { border-style: dashed; border-color: var(--edge); background: transparent; color: var(--muted); }
.option.picked { border-style: solid; border-color: var(--fg); color: var(--fg); }
.none { margin: 0; color: var(--muted); font-size: 14px; }
.result { margin-top: 12px; padding: 10px 12px; border-radius: 8px; font-size: 14px; border: 1px solid var(--line); color: var(--muted); }
.result strong, .result span { display: block; }
.result strong { margin-bottom: 2px; }
.result.pressing { padding: 0 2px; border: 0; }
.result.answered, .result.earlier { color: var(--fg); background: var(--card); border-color: var(--edge); }
.result.answered span::before { content: "✓"; margin-right: 6px; font-weight: 700; }
.result.answered { font-weight: 600; }
.result.refused { color: var(--bad-fg); background: var(--bad-bg); border-color: var(--bad-line); }
.result.unheard { color: var(--warn-fg); background: var(--warn-bg); border-color: var(--warn-line); }
.run.answered .meta, .run.answered .screen, .run.answered .unread, .run.answered .actions, .run.answered .fresh { display: none; }

.foot { margin: 8px 0 40px; padding-top: 20px; border-top: 1px solid var(--line); }
#paired-with { margin: 0; color: var(--muted); font-size: 14px; overflow-wrap: anywhere; }
.quiet { margin-top: 4px; min-height: 44px; padding: 10px 0; border: 0; background: none; color: var(--bad-fg); font-size: 15px; font-weight: 500; }
dialog { width: min(100% - 48px, 400px); padding: 20px; border: 1px solid var(--edge); border-radius: 14px; background: var(--card); color: var(--fg); box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35); }
dialog::backdrop { background: rgba(0, 0, 0, 0.55); }
dialog h2 { margin: 0 0 8px; font-size: 18px; }
dialog p { margin: 0; color: var(--muted); font-size: 15px; }
dialog .error { margin-top: 12px; }
.dialog-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 20px; }
.dialog-actions button { min-height: 48px; padding: 10px 16px; border-radius: 10px; border: 1px solid var(--edge); background: var(--card); font-weight: 600; }
.dialog-actions .danger { border-color: var(--bad-fg); background: var(--bad-fg); color: var(--card); }
@media (min-width: 600px) {
  .dialog-actions { flex-direction: row-reverse; }
}
@media (forced-colors: active) {
  .option, .result, .fresh, #hosts, #status, .notice { border-color: CanvasText; }
}
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
<div id="pair" class="wrap" hidden>
  <h1 id="pair-title" tabindex="-1">Pair with Daintree</h1>
  <p id="pair-target" class="target" hidden></p>
  <p id="pair-ended" class="notice" role="status" hidden>This device was removed or its pairing ended. Get a new code in Daintree → Settings → Hosts.</p>
  <p class="lede">See the screens of agents waiting on that computer and the hosts it's connected to, and pick the options they show. This device can't type, start agents or read anything else.</p>
  <form id="pair-form" autocomplete="off">
    <label for="code">Pairing code</label>
    <p id="code-hint" class="hint">8 letters and numbers, like ABCD-EFGH. In Daintree, open Settings → Hosts → Answer from another device and choose Show pairing code.</p>
    <input id="code" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="16" aria-describedby="code-hint pair-error" required>
    <label for="name">Name for this device</label>
    <input id="name" maxlength="60" placeholder="My phone" autocomplete="off">
    <button id="pair-submit" class="primary" type="submit">Pair</button>
    <p id="pair-error" class="error" role="alert"></p>
  </form>
  <p class="small">You can remove this device any time, here or in Daintree's settings.</p>
</div>
<div id="main" hidden>
  <header id="top" class="top">
    <div class="wrap">
      <h1 id="title" tabindex="-1">Waiting agents <span id="count" class="count"></span></h1>
      <p id="updated"></p>
      <p id="status" hidden></p>
    </div>
  </header>
  <div class="wrap">
    <ul id="hosts" hidden></ul>
    <div id="empty" hidden>
      <p id="empty-covered"></p>
      <p id="empty-checked"></p>
    </div>
    <div id="runs"></div>
    <footer class="foot">
      <p id="paired-with"></p>
      <button id="forget" class="quiet" type="button">Unpair this device</button>
    </footer>
  </div>
</div>
<dialog id="unpair-dialog" aria-labelledby="unpair-title" aria-describedby="unpair-body">
  <h2 id="unpair-title">Unpair this device?</h2>
  <p id="unpair-body">It's removed from Daintree on <span id="unpair-where">this computer</span> too, not just forgotten here. To answer from it again, you'll need a new pairing code.</p>
  <p id="unpair-error" class="error" role="alert"></p>
  <div class="dialog-actions">
    <button id="unpair-confirm" class="danger" type="button">Unpair device</button>
    <button id="unpair-cancel" type="button">Cancel</button>
  </div>
</dialog>
<p id="announce" class="sr" role="status" aria-live="polite"></p>
<script>${SCRIPT}</script>
</body>
</html>
`;
