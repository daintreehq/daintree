const path = require("path");
const fs = require("fs");

/**
 * Strip node-gyp's build metadata before electron-builder packs the app, so it
 * cannot break the macOS universal merge.
 *
 * Alongside each compiled binary, node-gyp leaves a pile of arch-specific
 * bookkeeping: `config.gypi` (records target_arch), `Makefile`,
 * `binding.Makefile`, `*.target.mk`, `gyp-mac-tool`, plus `Release/.deps`
 * dependency lists and `Release/obj.target` object files. None of it is loaded
 * at runtime, and all of it differs between the x64 and arm64 passes.
 *
 * @electron/universal's mergeASARs has two failure modes, and only one has an
 * escape hatch (see asar-utils.ts):
 *
 *   - a file unique to one arch  -> checked against the `singleArchFiles`
 *     allowList, which `mac.singleArchFiles` supplies
 *   - a file in BOTH arches whose bytes differ and which is not Mach-O ->
 *     `Can't reconcile two non-macho files <path>`, thrown unconditionally
 *
 * So the metadata must not survive in both arches. Deleting it here means the
 * arch whose native rebuild runs after this hook regenerates it while the other
 * does not, which downgrades the fatal case to the allowListed one.
 *
 * Deleting is also the only lever that reliably binds: these are local `file:`
 * dependencies symlinked into node_modules, so the same bytes are reachable
 * under two paths (`node_modules/<pkg>/...` and the realpath
 * `electron/native/<pkg>/...`), and neither `files` negations nor the packages'
 * own `.npmignore` excluded them in practice.
 *
 * Only `build/Release/<binary>` is kept. Those are Mach-O, so the merge lipos
 * them together instead of comparing bytes.
 */

/**
 * Inside `build/Release`, everything except the compiled binaries. `.deps` and
 * `obj.target` are node-gyp intermediates; `.forge-meta` is a build marker.
 */
const RELEASE_JUNK = new Set([".deps", "obj.target", ".forge-meta"]);

/** Roots that can contain a node-gyp `build` tree. */
const SEARCH_ROOTS = ["electron/native", "node_modules"];

/** Depth cap — a gyp build dir sits at <root>/[scope/]<pkg>/build. */
const MAX_DEPTH = 3;

/**
 * Strip a single `build` directory down to just its compiled output: drop every
 * top-level entry except `Release`, then drop the junk inside `Release`.
 */
function stripBuildDir(buildDir, removed) {
  let entries;
  try {
    entries = fs.readdirSync(buildDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name === "Release") continue;
    const full = path.join(buildDir, entry.name);
    fs.rmSync(full, { recursive: true, force: true });
    removed.push(full);
  }

  let releaseEntries;
  try {
    releaseEntries = fs.readdirSync(path.join(buildDir, "Release"), { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of releaseEntries) {
    if (!RELEASE_JUNK.has(entry.name)) continue;
    const full = path.join(buildDir, "Release", entry.name);
    fs.rmSync(full, { recursive: true, force: true });
    removed.push(full);
  }
}

/**
 * A `build` directory is only node-gyp output if its package has a
 * `binding.gyp` beside it. Plenty of packages ship hand-written JavaScript in a
 * directory called `build` — ink, yargs, @sentry/*, pkijs — and stripping those
 * would delete code the app loads at runtime. `binding.gyp` is the gyp source
 * file, so unlike `config.gypi` it survives this hook and still identifies the
 * directory on a second invocation.
 */
function isNodeGypBuildDir(packageDir) {
  return fs.existsSync(path.join(packageDir, "binding.gyp"));
}

function findBuildDirs(dir, depth, removed) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);

    if (entry.name === "build") {
      if (isNodeGypBuildDir(dir)) stripBuildDir(full, removed);
      continue;
    }

    // Never follow symlinks: every `file:` dependency's realpath is already
    // reached through electron/native, and following the link would strip the
    // same tree twice under two names.
    if (depth < MAX_DEPTH && !entry.isSymbolicLink()) {
      findBuildDirs(full, depth + 1, removed);
    }
  }
}

exports.default = async function beforePack(context) {
  const projectDir = context.packager.info.projectDir;
  const removed = [];

  for (const root of SEARCH_ROOTS) {
    findBuildDirs(path.join(projectDir, root), 0, removed);
  }

  if (removed.length === 0) {
    console.log("[beforePack] no node-gyp build metadata to strip");
    return;
  }

  console.log(`[beforePack] stripped ${removed.length} node-gyp build artefact(s):`);
  for (const dir of removed) {
    console.log(`[beforePack]   ${path.relative(projectDir, dir)}`);
  }
};
