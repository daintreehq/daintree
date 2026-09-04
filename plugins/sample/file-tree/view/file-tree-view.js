import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
//#region packages/plugin-sdk/dist/react.js
function getPluginHostBridge() {
	const bridge = globalThis.electron?.plugin;
	if (!bridge) throw new Error("@daintreehq/plugin-sdk/react: window.electron.plugin is unavailable — these hooks run only inside a Daintree plugin renderer view.");
	return bridge;
}
function useHostChannel(pluginId, channel) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(null);
	const callIdRef = useRef(0);
	useEffect(() => {
		setLoading(false);
		setError(null);
	}, [pluginId, channel]);
	return {
		invoke: useCallback(async (args) => {
			const callId = ++callIdRef.current;
			setLoading(true);
			setError(null);
			try {
				const result = await getPluginHostBridge().invoke(pluginId, channel, args);
				if (callId !== callIdRef.current) return void 0;
				return result;
			} catch (err) {
				if (callId !== callIdRef.current) return void 0;
				setError(err instanceof Error ? err : new Error(String(err)));
				return;
			} finally {
				if (callId === callIdRef.current) setLoading(false);
			}
		}, [pluginId, channel]),
		loading,
		error
	};
}
//#endregion
//#region packages/plugin-sdk/dist/files.js
var DEFAULT_FILE_SORT = {
	key: "name",
	direction: "asc"
};
function isDefaultFileSort(sort) {
	return sort.key === DEFAULT_FILE_SORT.key && sort.direction === DEFAULT_FILE_SORT.direction;
}
var NAME_COLLATOR = new Intl.Collator(void 0, { numeric: true });
function compareNames(a, b) {
	const collated = NAME_COLLATOR.compare(a, b);
	if (collated !== 0) return collated;
	return a < b ? -1 : a > b ? 1 : 0;
}
function fileExtension(name) {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return "";
	return name.slice(dot + 1).toLowerCase();
}
function compareByKey(a, b, key) {
	switch (key) {
		case "modified": return compareOptionalNumbers(a.mtimeMs, b.mtimeMs);
		case "size": return compareOptionalNumbers(a.size, b.size);
		case "type": return compareNames(fileExtension(a.name), fileExtension(b.name));
		case "name": return 0;
	}
}
function compareOptionalNumbers(a, b) {
	const knownA = a !== void 0 && Number.isFinite(a);
	const knownB = b !== void 0 && Number.isFinite(b);
	if (!knownA && !knownB) return 0;
	if (!knownA) return Number.POSITIVE_INFINITY;
	if (!knownB) return Number.NEGATIVE_INFINITY;
	return a === b ? 0 : a < b ? -1 : 1;
}
function sortFileNodes(nodes, sort) {
	if (isDefaultFileSort(sort)) return nodes;
	const flip = sort.direction === "desc" ? -1 : 1;
	return [...nodes].sort((a, b) => {
		if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
		const primary = compareByKey(a, b, sort.key);
		if (!Number.isFinite(primary)) return primary > 0 ? 1 : -1;
		if (primary !== 0) return primary * flip;
		return compareNames(a.name, b.name) * flip;
	});
}
function matchesBasenameGlob(name, pattern) {
	let n = 0;
	let p = 0;
	let starP = -1;
	let starN = 0;
	while (n < name.length) if (p < pattern.length && pattern[p] === "*") {
		starP = p;
		starN = n;
		p += 1;
	} else if (p < pattern.length && pattern[p] === name[n]) {
		n += 1;
		p += 1;
	} else if (starP !== -1) {
		p = starP + 1;
		starN += 1;
		n = starN;
	} else return false;
	while (p < pattern.length && pattern[p] === "*") p += 1;
	return p === pattern.length;
}
function createBasenameMatcher(patterns) {
	const exact = [];
	const globs = [];
	for (const pattern of patterns) if (pattern.includes("*")) globs.push(pattern);
	else exact.push(pattern);
	return (name) => exact.includes(name) || globs.some((pattern) => matchesBasenameGlob(name, pattern));
}
function createVisibilityFilter(visibility) {
	const { hideDotfiles, alwaysHiddenPatterns } = visibility;
	const isJunk = createBasenameMatcher(alwaysHiddenPatterns);
	return (name) => {
		if (isJunk(name)) return false;
		if (hideDotfiles && name.startsWith(".")) return false;
		return true;
	};
}
function countHiddenRows(listings, expandedPaths, rootPath = "", visibility) {
	const { hideDotfiles, alwaysHiddenPatterns } = visibility;
	let dotfiles = 0;
	let alwaysHidden = 0;
	const isJunk = createBasenameMatcher(alwaysHiddenPatterns);
	const walk = (dirPath, depth) => {
		if (depth > MAX_TREE_DEPTH) return;
		const listed = listings.get(dirPath);
		if (!listed) return;
		for (const node of listed) {
			if (isJunk(node.name)) {
				alwaysHidden += 1;
				continue;
			}
			if (hideDotfiles && node.name.startsWith(".")) {
				dotfiles += 1;
				continue;
			}
			if (node.isDirectory && expandedPaths.has(node.path)) walk(node.path, depth + 1);
		}
	};
	walk(rootPath, 0);
	return {
		dotfiles,
		alwaysHidden
	};
}
function flattenTree(listings, expandedPaths, loadingPaths, rootPath = "", isVisible, sort = DEFAULT_FILE_SORT) {
	const rows = [];
	const walk = (dirPath, depth) => {
		if (depth > MAX_TREE_DEPTH) return;
		const listed = listings.get(dirPath);
		if (!listed) return;
		const children = sortFileNodes(listed, sort);
		const visible = isVisible ? children.filter((node) => isVisible(node.name)) : children;
		let position = 0;
		for (const node of visible) {
			position += 1;
			const isExpanded = node.isDirectory && expandedPaths.has(node.path);
			rows.push({
				path: node.path,
				name: node.name,
				isDirectory: node.isDirectory,
				depth,
				isExpanded,
				isLoading: node.isDirectory && loadingPaths.has(node.path) && !listings.has(node.path),
				posInSet: position,
				setSize: visible.length,
				...node.size != null && { size: node.size },
				...node.symlink && { symlink: node.symlink }
			});
			if (isExpanded) walk(node.path, depth + 1);
		}
	};
	walk(rootPath, 0);
	return rows;
}
var MAX_TREE_DEPTH = 64;
function resolveTreeKey(key, rows, cursorPath) {
	if (rows.length === 0) return null;
	const index = cursorPath === null ? -1 : rows.findIndex((row) => row.path === cursorPath);
	const current = index >= 0 ? rows[index] : void 0;
	switch (key) {
		case "ArrowDown": {
			const next = rows[Math.min(index + 1, rows.length - 1)];
			return next ? {
				type: "select",
				path: next.path
			} : null;
		}
		case "ArrowUp": {
			if (index <= 0) return null;
			const previous = rows[index - 1];
			return previous ? {
				type: "select",
				path: previous.path
			} : null;
		}
		case "ArrowRight":
			if (!current) return null;
			if (current.isDirectory && !current.isExpanded) return {
				type: "expand",
				path: current.path
			};
			if (current.isDirectory) {
				const child = rows[index + 1];
				return child && child.depth > current.depth ? {
					type: "select",
					path: child.path
				} : null;
			}
			return null;
		case "ArrowLeft": {
			if (!current) return null;
			if (current.isDirectory && current.isExpanded) return {
				type: "collapse",
				path: current.path
			};
			const parent = findParentRow(rows, index);
			return parent ? {
				type: "select",
				path: parent.path
			} : null;
		}
		case "Home": {
			const first = rows[0];
			return first ? {
				type: "select",
				path: first.path
			} : null;
		}
		case "End": {
			const last = rows[rows.length - 1];
			return last ? {
				type: "select",
				path: last.path
			} : null;
		}
		case "Enter":
			if (!current) return null;
			return {
				type: "activate",
				path: current.path
			};
		default: return null;
	}
}
function findParentRow(rows, index) {
	const current = rows[index];
	if (!current || current.depth === 0) return void 0;
	for (let i = index - 1; i >= 0; i -= 1) {
		const candidate = rows[i];
		if (candidate && candidate.depth < current.depth) return candidate;
	}
}
var EXTENSION_CATEGORIES = {
	js: "source",
	jsx: "source",
	ts: "source",
	tsx: "source",
	mjs: "source",
	cjs: "source",
	mts: "source",
	cts: "source",
	html: "source",
	htm: "source",
	css: "source",
	scss: "source",
	sass: "source",
	less: "source",
	styl: "source",
	xml: "source",
	xsl: "source",
	py: "source",
	pyw: "source",
	pyi: "source",
	rb: "source",
	go: "source",
	rs: "source",
	java: "source",
	kt: "source",
	kts: "source",
	swift: "source",
	m: "source",
	mm: "source",
	c: "source",
	cc: "source",
	cpp: "source",
	cxx: "source",
	h: "source",
	hh: "source",
	hpp: "source",
	hxx: "source",
	cs: "source",
	php: "source",
	ex: "source",
	exs: "source",
	erl: "source",
	hrl: "source",
	fs: "source",
	fsx: "source",
	vb: "source",
	lua: "source",
	pl: "source",
	pm: "source",
	r: "source",
	scala: "source",
	dart: "source",
	sol: "source",
	zig: "source",
	nim: "source",
	hs: "source",
	clj: "source",
	cljs: "source",
	cljc: "source",
	groovy: "source",
	vue: "source",
	svelte: "source",
	astro: "source",
	graphql: "source",
	gql: "source",
	proto: "source",
	ipynb: "source",
	sh: "script",
	bash: "script",
	zsh: "script",
	fish: "script",
	ksh: "script",
	ps1: "script",
	psm1: "script",
	bat: "script",
	cmd: "script",
	nu: "script",
	json: "data",
	jsonc: "data",
	json5: "data",
	jsonl: "data",
	ndjson: "data",
	geojson: "data",
	topojson: "data",
	map: "data",
	yaml: "config",
	yml: "config",
	toml: "config",
	ini: "config",
	cfg: "config",
	conf: "config",
	config: "config",
	properties: "config",
	plist: "config",
	tf: "config",
	tfvars: "config",
	hcl: "config",
	lock: "lock",
	lockb: "lock",
	png: "image",
	jpg: "image",
	jpeg: "image",
	jpe: "image",
	gif: "image",
	webp: "image",
	avif: "image",
	svg: "image",
	ico: "image",
	icns: "image",
	bmp: "image",
	tif: "image",
	tiff: "image",
	heic: "image",
	heif: "image",
	psd: "image",
	ai: "image",
	sketch: "image",
	fig: "image",
	mp4: "video",
	m4v: "video",
	mov: "video",
	avi: "video",
	mkv: "video",
	webm: "video",
	mpeg: "video",
	mpg: "video",
	mpe: "video",
	wmv: "video",
	flv: "video",
	ogv: "video",
	"3gp": "video",
	"3g2": "video",
	mp3: "audio",
	wav: "audio",
	flac: "audio",
	aac: "audio",
	m4a: "audio",
	ogg: "audio",
	oga: "audio",
	opus: "audio",
	wma: "audio",
	aiff: "audio",
	aif: "audio",
	midi: "audio",
	mid: "audio",
	zip: "archive",
	"7z": "archive",
	rar: "archive",
	tar: "archive",
	gz: "archive",
	tgz: "archive",
	bz2: "archive",
	tbz: "archive",
	tbz2: "archive",
	xz: "archive",
	txz: "archive",
	zst: "archive",
	tzst: "archive",
	lz: "archive",
	lz4: "archive",
	cab: "archive",
	iso: "archive",
	dmg: "archive",
	jar: "archive",
	war: "archive",
	ear: "archive",
	apk: "archive",
	ipa: "archive",
	deb: "archive",
	rpm: "archive",
	pkg: "archive",
	msi: "archive",
	nupkg: "archive",
	gem: "archive",
	whl: "archive",
	egg: "archive",
	crate: "archive",
	txt: "document",
	md: "document",
	mdx: "document",
	markdown: "document",
	rst: "document",
	adoc: "document",
	asciidoc: "document",
	org: "document",
	rtf: "document",
	pdf: "document",
	tex: "document",
	bib: "document",
	log: "document",
	doc: "document",
	docx: "document",
	odt: "document",
	pages: "document",
	ppt: "document",
	pptx: "document",
	odp: "document",
	csv: "spreadsheet",
	tsv: "spreadsheet",
	xls: "spreadsheet",
	xlsx: "spreadsheet",
	xlsm: "spreadsheet",
	ods: "spreadsheet",
	ots: "spreadsheet",
	numbers: "spreadsheet",
	sql: "database",
	db: "database",
	db3: "database",
	sqlite: "database",
	sqlite3: "database",
	duckdb: "database",
	parquet: "database",
	avro: "database",
	orc: "database",
	ttf: "font",
	otf: "font",
	woff: "font",
	woff2: "font",
	eot: "font",
	pem: "key",
	crt: "key",
	cer: "key",
	der: "key",
	p12: "key",
	pfx: "key",
	key: "key",
	pub: "key",
	jks: "key",
	keystore: "key",
	gpg: "key",
	asc: "key",
	bin: "binary",
	exe: "binary",
	dll: "binary",
	so: "binary",
	dylib: "binary",
	o: "binary",
	obj: "binary",
	a: "binary",
	lib: "binary",
	class: "binary",
	pyc: "binary",
	pyo: "binary",
	wasm: "binary"
};
var BASENAME_CATEGORIES = {
	"package-lock.json": "lock",
	"npm-shrinkwrap.json": "lock",
	"packages.lock.json": "lock",
	"pnpm-lock.yaml": "lock",
	"yarn.lock": "lock",
	"bun.lock": "lock",
	"bun.lockb": "lock",
	"deno.lock": "lock",
	"cargo.lock": "lock",
	"gemfile.lock": "lock",
	"composer.lock": "lock",
	"poetry.lock": "lock",
	"pipfile.lock": "lock",
	"uv.lock": "lock",
	"mix.lock": "lock",
	"go.sum": "lock",
	"flake.lock": "lock",
	"pubspec.lock": "lock",
	"podfile.lock": "lock",
	"package.resolved": "lock",
	"gradle.lockfile": "lock",
	".terraform.lock.hcl": "lock",
	dockerfile: "config",
	containerfile: "config",
	makefile: "config",
	gnumakefile: "config",
	justfile: "config",
	procfile: "config",
	rakefile: "config",
	gemfile: "config",
	pipfile: "config",
	brewfile: "config",
	vagrantfile: "config",
	"cmakelists.txt": "config",
	"meson.build": "config",
	"package.json": "config",
	"deno.json": "config",
	"deno.jsonc": "config",
	"composer.json": "config",
	"bower.json": "config",
	"go.mod": "config",
	"go.work": "config",
	"build.gradle": "config",
	"build.gradle.kts": "config",
	"settings.gradle": "config",
	"settings.gradle.kts": "config",
	gradlew: "script",
	codeowners: "config",
	".gitignore": "config",
	".gitattributes": "config",
	".gitmodules": "config",
	".gitkeep": "config",
	".dockerignore": "config",
	".npmignore": "config",
	".prettierignore": "config",
	".eslintignore": "config",
	".editorconfig": "config",
	".nvmrc": "config",
	".node-version": "config",
	".python-version": "config",
	".ruby-version": "config",
	".tool-versions": "config",
	readme: "document",
	license: "document",
	licence: "document",
	changelog: "document",
	contributing: "document",
	notice: "document",
	authors: "document",
	contributors: "document",
	copying: "document",
	install: "document",
	todo: "document"
};
var BASENAME_PATTERNS = [
	[/^\.env(\..+)?$/, "config"],
	[/\.config\.([cm]?[jt]s|jsonc?|json5|ya?ml|toml|ini)$/, "config"],
	[/^[jt]sconfig(\..+)?\.json$/, "config"],
	[/^\.[a-z0-9_-]+rc(\.[a-z0-9]+)?$/, "config"],
	[/^(docker|container)file\..+$/, "config"],
	[/^(docker-)?compose(\..+)?\.ya?ml$/, "config"]
];
function basenameOf(filePath) {
	const posix = filePath.split("/").pop() ?? filePath;
	return (posix.split("\\").pop() ?? posix).toLowerCase();
}
function getFileTypeCategory(filePath) {
	const basename = basenameOf(filePath);
	if (Object.hasOwn(BASENAME_CATEGORIES, basename)) return BASENAME_CATEGORIES[basename];
	for (const [pattern, category] of BASENAME_PATTERNS) if (pattern.test(basename)) return category;
	const dotIndex = basename.lastIndexOf(".");
	if (dotIndex > 0) {
		const extension = basename.slice(dotIndex + 1);
		if (Object.hasOwn(EXTENSION_CATEGORIES, extension)) return EXTENSION_CATEGORIES[extension];
	}
	return "unknown";
}
//#endregion
//#region plugins/sample/file-tree/renderer/file-tree-view.tsx
function readPersisted(initialArgs) {
	const expanded = initialArgs?.["expanded"];
	const selected = initialArgs?.["selected"];
	return {
		expanded: Array.isArray(expanded) ? expanded.filter((value) => typeof value === "string") : [],
		selected: typeof selected === "string" ? selected : null
	};
}
function FileTreeView({ pluginId, initialArgs, persistState }) {
	const restored = useMemo(() => readPersisted(initialArgs), [initialArgs]);
	const [root, setRoot] = useState(null);
	const [listings, setListings] = useState(() => /* @__PURE__ */ new Map());
	const [expanded, setExpanded] = useState(() => new Set(restored.expanded));
	const [pending, setPending] = useState(() => /* @__PURE__ */ new Set());
	/** Directories the host refused to list, keyed the way the model keys them. */
	const [failed, setFailed] = useState(() => /* @__PURE__ */ new Set());
	const [cursor, setCursor] = useState(restored.selected);
	const [hideDotfiles, setHideDotfiles] = useState(true);
	const rootChannel = useHostChannel(pluginId, "root");
	const listChannel = useHostChannel(pluginId, "list-directory");
	const invokeList = useRef(listChannel.invoke);
	invokeList.current = listChannel.invoke;
	const invokeRoot = useRef(rootChannel.invoke);
	invokeRoot.current = rootChannel.invoke;
	/**
	* Directory loads are serialized through one chain.
	*
	* `useHostChannel` is deliberately single-flight: a second `invoke` before
	* the first resolves drops the earlier call, which resolves `undefined`. That
	* is right for a click handler and wrong for a fan-out — restoring four
	* expanded directories at once would land only the last one and silently lose
	* the rest. One channel means one queue.
	*/
	const queue = useRef(Promise.resolve());
	const enqueueLoad = useCallback((dirPath, relative) => {
		setPending((current) => new Set(current).add(relative));
		setFailed((current) => {
			if (!current.has(relative)) return current;
			const next = new Set(current);
			next.delete(relative);
			return next;
		});
		queue.current = queue.current.then(async () => {
			try {
				const entries = await invokeList.current({ dirPath });
				if (!entries) {
					setFailed((current) => new Set(current).add(relative));
					return;
				}
				setListings((current) => {
					const next = new Map(current);
					next.set(relative, entries.map((entry) => ({
						...entry,
						path: relative === "" ? entry.name : `${relative}/${entry.name}`
					})));
					return next;
				});
			} finally {
				setPending((current) => {
					const next = new Set(current);
					next.delete(relative);
					return next;
				});
			}
		});
		return queue.current;
	}, []);
	const startedRef = useRef(false);
	useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;
		(async () => {
			const resolved = await invokeRoot.current(void 0);
			if (!resolved?.path) return;
			setRoot(resolved.path);
			await enqueueLoad(resolved.path, "");
			for (const dir of restored.expanded) await enqueueLoad(`${resolved.path}/${dir}`, dir);
		})();
	}, [enqueueLoad, restored.expanded]);
	const visibility = useMemo(() => ({
		hideDotfiles,
		alwaysHiddenPatterns: [".git", "node_modules"]
	}), [hideDotfiles]);
	const isVisible = useMemo(() => createVisibilityFilter(visibility), [visibility]);
	const rows = useMemo(() => flattenTree(listings, expanded, pending, "", isVisible, DEFAULT_FILE_SORT), [
		listings,
		expanded,
		pending,
		isVisible
	]);
	const hidden = useMemo(() => countHiddenRows(listings, expanded, "", visibility), [
		listings,
		expanded,
		visibility
	]);
	const select = useCallback((path) => {
		setCursor(path);
		persistState?.({ selected: path });
	}, [persistState]);
	const setExpansion = useCallback((path, shouldExpand) => {
		const next = new Set(expanded);
		if (shouldExpand) next.add(path);
		else next.delete(path);
		setExpanded(next);
		persistState?.({ expanded: [...next] });
		if (shouldExpand && !listings.has(path) && root !== null) enqueueLoad(`${root}/${path}`, path);
	}, [
		expanded,
		listings,
		root,
		enqueueLoad,
		persistState
	]);
	const activate = useCallback((path, isDirectory) => {
		select(path);
		if (isDirectory) setExpansion(path, !expanded.has(path));
	}, [
		select,
		setExpansion,
		expanded
	]);
	const retryRoot = useCallback(async () => {
		const resolved = await invokeRoot.current(void 0);
		if (!resolved?.path) return;
		setRoot(resolved.path);
		await enqueueLoad(resolved.path, "");
	}, [enqueueLoad]);
	const onKeyDown = useCallback((event) => {
		const intent = resolveTreeKey(event.key, rows, cursor);
		if (!intent) return;
		event.preventDefault();
		switch (intent.type) {
			case "select":
				select(intent.path);
				return;
			case "expand":
				setExpansion(intent.path, true);
				return;
			case "collapse":
				setExpansion(intent.path, false);
				return;
			case "activate": {
				const row = rows.find((candidate) => candidate.path === intent.path);
				if (row) activate(intent.path, row.isDirectory);
				return;
			}
		}
	}, [
		rows,
		cursor,
		select,
		setExpansion,
		activate
	]);
	if (root === null) return failed.has("") ? /* @__PURE__ */ jsxs("div", {
		"data-testid": "file-tree-error",
		children: [/* @__PURE__ */ jsx("p", { children: "Could not read the worktree." }), /* @__PURE__ */ jsx("button", {
			"data-testid": "file-tree-retry",
			onClick: () => void retryRoot(),
			children: "Try again"
		})]
	}) : /* @__PURE__ */ jsx("div", {
		"data-testid": "file-tree-empty",
		children: "No worktree to browse"
	});
	return /* @__PURE__ */ jsxs("div", {
		"data-testid": "file-tree-view",
		style: {
			font: "12px system-ui",
			padding: 8
		},
		children: [/* @__PURE__ */ jsxs("div", {
			style: {
				display: "flex",
				gap: 8,
				alignItems: "center",
				marginBottom: 6
			},
			children: [/* @__PURE__ */ jsx("button", {
				"data-testid": "file-tree-toggle-dotfiles",
				onClick: () => setHideDotfiles((v) => !v),
				children: hideDotfiles ? "Show hidden" : "Hide hidden"
			}), /* @__PURE__ */ jsx("span", {
				"data-testid": "file-tree-hidden-count",
				children: `${hidden.dotfiles + hidden.alwaysHidden} hidden`
			})]
		}), /* @__PURE__ */ jsx("div", {
			role: "tree",
			tabIndex: 0,
			onKeyDown,
			"data-testid": "file-tree-rows",
			children: rows.map((row) => /* @__PURE__ */ jsxs("div", {
				role: "treeitem",
				"aria-expanded": row.isDirectory ? row.isExpanded : void 0,
				"aria-selected": row.path === cursor,
				"aria-level": row.depth + 1,
				"aria-posinset": row.posInSet,
				"aria-setsize": row.setSize,
				"data-testid": `file-tree-row-${row.path}`,
				onClick: () => activate(row.path, row.isDirectory),
				style: {
					paddingLeft: 8 + row.depth * 14,
					background: row.path === cursor ? "rgba(91,141,239,0.25)" : void 0,
					cursor: "pointer"
				},
				children: [
					/* @__PURE__ */ jsxs("span", {
						"aria-hidden": "true",
						children: [row.isDirectory ? row.isExpanded ? "▾" : "▸" : "·", row.isLoading ? "…" : ""]
					}),
					" ",
					/* @__PURE__ */ jsx("span", {
						"data-category": getFileTypeCategory(row.name),
						children: row.name
					}),
					failed.has(row.path) ? /* @__PURE__ */ jsxs("span", {
						"data-testid": `file-tree-failed-${row.path}`,
						children: [" ", "— unreadable, click to retry"]
					}) : null
				]
			}, row.path))
		})]
	});
}
//#endregion
export { FileTreeView as default };
