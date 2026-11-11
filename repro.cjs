// Reproduces Daintree's startup restore of native-fullscreen windows on macOS.
// VARIANT: "restack" (v0.50.0: focused.moveTop() after each showInactive), "none" (v0.49.0).
const { app, BrowserWindow, screen } = require("electron");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const VARIANT = process.env.VARIANT || "restack";
const COUNT = Number(process.env.COUNT || 4);
const PRIMARY_SETTLE_MS = Number(process.env.PRIMARY_SETTLE_MS || 3000);
const GAP_MS = Number(process.env.GAP_MS || 2500);
const OUT = process.env.OUT_DIR;
const PROBE = process.env.PROBE;
app.setPath("userData", path.join(OUT, "userData"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => {
  const line = `[${(performance.now() / 1000).toFixed(2)}s] ${a.join(" ")}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT, "log.txt"), line + "\n");
};
const colors = ["#7a1f1f", "#1f5a7a", "#2f7a1f", "#7a6a1f", "#5a1f7a", "#1f7a6a"];

function makeWindow(i) {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 18 },
    backgroundColor: colors[i],
  });
  win.loadURL(
    "data:text/html," +
      encodeURIComponent(
        `<body style="margin:0;background:${colors[i]};color:white;font:bold 64px sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">W${i}</body>`
      )
  );
  win.__name = `W${i}`;
  for (const ev of ["enter-full-screen", "leave-full-screen", "show", "focus", "blur"]) {
    win.on(ev, () => log(win.__name, ev, `fs=${win.isFullScreen()}`));
  }
  // windowState.ts: a window saved full screen goes full screen when it shows.
  win.once("show", () => win.setFullScreen(true));
  return win;
}

function showWindowInactive(win) {
  const focused = BrowserWindow.getFocusedWindow();
  win.showInactive();
  log(win.__name, `showInactive done, focused=${focused?.__name ?? "none"}`);
  if (VARIANT === "restack" && focused && focused !== win && !focused.isDestroyed()) {
    focused.moveTop();
    log(focused.__name, "moveTop");
  }
}

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" });
  } catch (e) {
    return `ERR ${e.message}`;
  }
}

async function probe(win, label) {
  const { bounds } = screen.getPrimaryDisplay();
  const cx = bounds.x + Math.round(bounds.width / 2);
  win.focus();
  await sleep(2500);
  log(win.__name, `probe ${label} fs=${win.isFullScreen()} simple=${win.isSimpleFullScreen()} focused=${win.isFocused()} visible=${win.isVisible()}`);
  sh(PROBE, ["away", String(cx), String(bounds.y + 400)]);
  await sleep(800);
  sh("screencapture", ["-x", path.join(OUT, `${label}-${win.__name}-rest.png`)]);
  fs.writeFileSync(path.join(OUT, `${label}-${win.__name}-rest-windows.txt`), sh(PROBE, ["list", String(process.pid)]));
  sh(PROBE, ["hover", String(cx), String(bounds.y)]);
  await sleep(1500);
  sh("screencapture", ["-x", path.join(OUT, `${label}-${win.__name}-hover.png`)]);
  fs.writeFileSync(path.join(OUT, `${label}-${win.__name}-hover-windows.txt`), sh(PROBE, ["list", String(process.pid)]));
  sh(PROBE, ["away", String(cx), String(bounds.y + 400)]);
  await sleep(500);
}

app.whenReady().then(async () => {
  log(`variant=${VARIANT} count=${COUNT} display=${JSON.stringify(screen.getPrimaryDisplay().bounds)}`);
  const wins = [makeWindow(0)];
  wins[0].show();
  await sleep(PRIMARY_SETTLE_MS);
  for (let i = 1; i < COUNT; i++) {
    const w = makeWindow(i);
    wins.push(w);
    await sleep(300);
    showWindowInactive(w);
    await sleep(GAP_MS);
  }
  await sleep(3000);
  for (const w of wins) await probe(w, "after-restore");
  // Justin's recovery: toggle fullscreen off and on again.
  const last = wins[wins.length - 1];
  last.focus();
  await sleep(1500);
  last.setFullScreen(false);
  await sleep(2500);
  last.setFullScreen(true);
  await sleep(2500);
  await probe(last, "after-toggle");
  log("done");
  app.exit(0);
});
