import { i as REQUEST_STATUSES, n as EVENTS, r as MAX_NOTES_CHARS, t as CHANNELS } from "./contracts-Bojho-XK.js";
Object.freeze({
	maxVersion: 1e6,
	maxSections: 24,
	maxIdLength: 64,
	maxTitleLength: 64,
	maxParamsPerSection: 8,
	maxParamNameLength: 32,
	defaultStringLength: 64,
	maxStringLength: 128,
	/** Serialized size of one location, as UTF-8 JSON. */
	maxLocationBytes: 2048,
	/** Entries in one project's history, the current one included. */
	maxHistoryEntries: 30
});
var PLUGIN_TASK_MESSAGE_MAX = 2e3;
var OPERATION_TERMINAL_STATES = [
	"succeeded",
	"failed",
	"cancelled",
	"abandoned"
];
var OPERATION_INPUT_MAX_CHARS = 32 * 1024;
var OPERATION_CHECKPOINT_MAX_CHARS = 16 * 1024;
var OPERATION_RESULT_MAX_CHARS = 64 * 1024;
var OperationError = class extends Error {
	code;
	retryable;
	constructor(code, message, options = {}) {
		super(message);
		this.name = "OperationError";
		this.code = code;
		this.retryable = options.retryable ?? true;
	}
};
var OperationConflictError = class extends Error {
	operationId;
	constructor(operationId) {
		super(`idempotency key already used by operation ${operationId} with a different request`);
		this.name = "OperationConflictError";
		this.operationId = operationId;
	}
};
var OperationCapacityError = class extends Error {
	constructor(limit) {
		super(`already tracking ${limit} unfinished operations`);
		this.name = "OperationCapacityError";
	}
};
var MIGRATIONS$1 = [`CREATE TABLE operations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    project_id TEXT,
    title TEXT NOT NULL,
    input TEXT NOT NULL,
    state TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    provider_id TEXT,
    checkpoint TEXT,
    progress TEXT,
    result TEXT,
    error_code TEXT,
    error_message TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL,
    submitted_at INTEGER,
    cancel_requested_at INTEGER,
    cancel_sent_at INTEGER,
    cancel_failed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX operations_by_state ON operations (state, next_attempt_at);
  CREATE INDEX operations_by_project ON operations (project_id, created_at);`];
var TERMINAL = new Set(OPERATION_TERMINAL_STATES);
var TERMINAL_SQL = OPERATION_TERMINAL_STATES.map((s) => `'${s}'`).join(", ");
var POLL_STATUSES = /* @__PURE__ */ new Set([
	"running",
	"succeeded",
	"failed",
	"cancelled"
]);
var DEFAULT_RETRY = {
	initialIntervalMs: 1e3,
	backoffCoefficient: 2,
	maximumIntervalMs: 6e4,
	maximumAttempts: 10
};
var DEFAULT_DEADLINE_MS = 1440 * 60 * 1e3;
var DEFAULT_POLL_INTERVAL_MS = 5e3;
var DEFAULT_CALL_TIMEOUT_MS = 3e4;
var TASK_START_RETRY_MS = 5e3;
var StoppedError = class extends Error {};
var DeadlineError = class extends Error {};
var CallTimeoutError = class extends Error {};
var invalidResponse = (what) => new OperationError("INVALID_RESPONSE", `The provider adapter returned an invalid ${what}`);
function truncate(text, max) {
	return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}
function oneLine(text, max, fallback) {
	const line = text.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
	return truncate(line.length > 0 ? line : fallback, max);
}
function positiveNumber(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
function canonicalJson(value) {
	return JSON.stringify(value, (_key, v) => {
		if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
		return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
	});
}
async function sha256Hex(text) {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function encodeJson(value, max, what) {
	let text;
	try {
		text = JSON.stringify(value);
	} catch {
		throw new TypeError(`${what} must be JSON-serializable`);
	}
	if (text === void 0) throw new TypeError(`${what} must be JSON-serializable`);
	if (text.length > max) throw new RangeError(`${what} exceeds ${max} characters of JSON`);
	return text;
}
function encodeCheckpoint(value) {
	try {
		return encodeJson(value, OPERATION_CHECKPOINT_MAX_CHARS, "checkpoint");
	} catch {
		return;
	}
}
function parseJson(text) {
	return text === null ? void 0 : JSON.parse(text);
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validProviderId(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 1024;
}
function describeFailure(error) {
	if (error instanceof OperationError) return {
		code: oneLine(String(error.code), 64, "OPERATION_ERROR"),
		message: oneLine(String(error.message), 500, "The operation failed")
	};
	if (error instanceof CallTimeoutError) return {
		code: "TIMEOUT",
		message: "The provider call timed out"
	};
	return {
		code: "PROVIDER_ERROR",
		message: "The provider call failed"
	};
}
function toSnapshot(row) {
	const snapshot = {
		id: row.id,
		kind: row.kind,
		idempotencyKey: row.idempotency_key,
		projectId: row.project_id,
		title: row.title,
		state: row.state,
		providerId: row.provider_id,
		progress: parseJson(row.progress) ?? null,
		error: row.error_code === null ? null : {
			code: row.error_code,
			message: row.error_message ?? ""
		},
		attempt: row.attempt,
		cancelRequested: row.cancel_requested_at !== null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		nextAttemptAt: row.next_attempt_at,
		deadlineAt: row.deadline_at
	};
	if (row.result !== null) snapshot.result = parseJson(row.result);
	return snapshot;
}
function createOperationManager(host, options) {
	const now = options.now ?? Date.now;
	const random = options.random ?? Math.random;
	const concurrency = Math.min(16, Math.max(1, Math.floor(positiveNumber(options.concurrency, 4))));
	const maxUnfinished = Math.floor(positiveNumber(options.maxUnfinished, 200));
	const retentionAgeMs = positiveNumber(options.retention?.maxAgeMs, 10080 * 60 * 1e3);
	const retentionCount = Math.floor(positiveNumber(options.retention?.maxCount, 500));
	let db = null;
	let starting = null;
	let disposed = false;
	let suspended = false;
	const driving = /* @__PURE__ */ new Map();
	const runs = /* @__PURE__ */ new Set();
	let pumping = false;
	let pumpRun = Promise.resolve();
	let pumpAgain = false;
	let pumpTimer = null;
	const kindOf = (kind) => {
		const def = Object.prototype.hasOwnProperty.call(options.kinds, kind) ? options.kinds[kind] : void 0;
		if (!def) throw new TypeError(`unknown operation kind "${kind}"`);
		return def;
	};
	const retryPolicy = (kind) => {
		const p = {
			...DEFAULT_RETRY,
			...kindOf(kind).retry
		};
		return {
			initialIntervalMs: positiveNumber(p.initialIntervalMs, DEFAULT_RETRY.initialIntervalMs),
			backoffCoefficient: positiveNumber(p.backoffCoefficient, DEFAULT_RETRY.backoffCoefficient),
			maximumIntervalMs: positiveNumber(p.maximumIntervalMs, DEFAULT_RETRY.maximumIntervalMs),
			maximumAttempts: Math.floor(positiveNumber(p.maximumAttempts, DEFAULT_RETRY.maximumAttempts))
		};
	};
	const backoff = (kind, failures) => {
		const p = retryPolicy(kind);
		const cap = Math.min(p.maximumIntervalMs, p.initialIntervalMs * p.backoffCoefficient ** Math.max(0, failures - 1));
		return Math.floor(random() * cap);
	};
	const pollInterval = (kind) => positiveNumber(kindOf(kind).pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
	const deadlineFor = (kind) => positiveNumber(kindOf(kind).deadlineMs, DEFAULT_DEADLINE_MS);
	const requireDb = () => {
		if (!db) throw new Error("operation manager is not running");
		return db;
	};
	const load = async (id, from = requireDb()) => from.get("SELECT * FROM operations WHERE id = ?", [id]);
	const transition = async (row, patch) => {
		const entries = Object.entries({
			...patch,
			updated_at: now()
		});
		const sets = entries.map(([column]) => `${column} = ?`).join(", ");
		return (await requireDb().run(`UPDATE operations SET ${sets} WHERE id = ? AND state = ? AND generation = ?`, [
			...entries.map(([, value]) => value),
			row.id,
			row.state,
			row.generation
		])).changes > 0;
	};
	const failurePatch = (row, error, next) => {
		const failures = row.attempt + 1;
		const failure = describeFailure(error);
		if (failures >= retryPolicy(row.kind).maximumAttempts) return {
			state: "abandoned",
			attempt: failures,
			error_code: failure.code,
			error_message: truncate(`Stopped after ${failures} failed attempts; the provider's outcome is unknown. Last: ${failure.message}`, 500)
		};
		return {
			state: next,
			attempt: failures,
			next_attempt_at: now() + backoff(row.kind, failures),
			error_code: failure.code,
			error_message: failure.message
		};
	};
	const checkpointRejected = (providerId) => ({
		state: "abandoned",
		provider_id: providerId,
		error_code: "CHECKPOINT_REJECTED",
		error_message: "The adapter's checkpoint was too large or not JSON; the provider's outcome is unknown"
	});
	const call = async (row, drive, fn) => {
		if (drive.stop.signal.aborted) throw new StoppedError();
		const remaining = row.deadline_at - now();
		if (remaining <= 0) throw new DeadlineError();
		const controller = new AbortController();
		const timeoutMs = Math.min(positiveNumber(kindOf(row.kind).callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS), remaining);
		let onStop = () => {};
		let timer;
		const ended = new Promise((_, reject) => {
			timer = setTimeout(() => {
				reject(new CallTimeoutError());
				controller.abort();
			}, timeoutMs);
			onStop = () => {
				reject(new StoppedError());
				controller.abort();
			};
			drive.stop.signal.addEventListener("abort", onStop, { once: true });
		});
		ended.catch(() => {});
		try {
			const answer = Promise.resolve().then(() => fn({
				operationId: row.id,
				idempotencyKey: row.idempotency_key,
				signal: controller.signal
			}));
			answer.catch(() => {});
			return await Promise.race([ended, answer]);
		} finally {
			clearTimeout(timer);
			drive.stop.signal.removeEventListener("abort", onStop);
		}
	};
	const ref = (row) => ({
		providerId: row.provider_id ?? "",
		checkpoint: parseJson(row.checkpoint) ?? null
	});
	const waitFor = (ms, drive) => new Promise((resolve) => {
		if (ms <= 0 || drive.stop.signal.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			drive.stop.signal.removeEventListener("abort", done);
			drive.wake = () => {};
			resolve();
		};
		const timer = setTimeout(done, ms);
		drive.wake = done;
		drive.stop.signal.addEventListener("abort", done, { once: true });
	});
	const step = async (row, drive) => {
		const provider = kindOf(row.kind).provider;
		const input = () => JSON.parse(row.input);
		const cancelRequested = row.cancel_requested_at !== null;
		switch (row.state) {
			case "pending": {
				if (cancelRequested) {
					await transition(row, row.submitted_at === null ? { state: "cancelled" } : {
						state: "abandoned",
						error_code: "CANCEL_UNCONFIRMED",
						error_message: "Cancelled before the provider confirmed the submit; whether it received it is unknown"
					});
					return;
				}
				const sending = {
					state: "submitting",
					submitted_at: row.submitted_at ?? now()
				};
				if (!await transition(row, sending)) return;
				const submitting = {
					...row,
					...sending
				};
				let accepted;
				try {
					accepted = await call(row, drive, (ctx) => provider.submit(input(), ctx));
				} catch (error) {
					if (error instanceof StoppedError || error instanceof DeadlineError) return;
					if (error instanceof DeadlineError) {
						await transition(submitting, {
							state: "pending",
							submitted_at: row.submitted_at
						});
						return;
					}
					if (error instanceof OperationError && !error.retryable) {
						const failure = describeFailure(error);
						await transition(submitting, {
							state: "failed",
							error_code: failure.code,
							error_message: failure.message
						});
						return;
					}
					await transition(submitting, failurePatch(submitting, error, "uncertain"));
					return;
				}
				if (!isRecord(accepted) || !validProviderId(accepted.providerId)) {
					await transition(submitting, failurePatch(submitting, invalidResponse("submit answer"), "uncertain"));
					return;
				}
				const checkpoint = accepted.checkpoint === void 0 ? null : encodeCheckpoint(accepted.checkpoint);
				await transition(submitting, checkpoint === void 0 ? checkpointRejected(accepted.providerId) : {
					state: "running",
					provider_id: accepted.providerId,
					checkpoint,
					attempt: 0,
					error_code: null,
					error_message: null,
					next_attempt_at: now() + pollInterval(row.kind)
				});
				return;
			}
			case "submitting":
				await transition(row, { state: "uncertain" });
				return;
			case "uncertain": {
				const reconcile = provider.reconcile?.bind(provider);
				if (!reconcile) {
					await transition(row, { state: "pending" });
					return;
				}
				let found;
				try {
					found = await call(row, drive, (ctx) => reconcile(input(), ctx));
				} catch (error) {
					if (error instanceof StoppedError || error instanceof DeadlineError) return;
					await transition(row, failurePatch(row, error, "uncertain"));
					return;
				}
				const status = isRecord(found) ? found.status : void 0;
				if (status === "found" && isRecord(found) && validProviderId(found.providerId)) {
					const checkpoint = found.checkpoint === void 0 ? row.checkpoint : encodeCheckpoint(found.checkpoint);
					await transition(row, checkpoint === void 0 ? checkpointRejected(found.providerId) : {
						state: "running",
						provider_id: found.providerId,
						checkpoint,
						attempt: 0,
						error_code: null,
						error_message: null,
						next_attempt_at: now()
					});
				} else if (status === "not-found") await transition(row, cancelRequested ? { state: "cancelled" } : {
					state: "pending",
					submitted_at: null,
					next_attempt_at: now()
				});
				else await transition(row, failurePatch(row, status === "unknown" ? new OperationError("UNRECONCILED", "The provider could not say whether it received the submit") : invalidResponse("reconcile answer"), "uncertain"));
				return;
			}
			case "running": {
				const cancel = provider.cancel?.bind(provider);
				if (cancelRequested && row.cancel_sent_at === null) {
					let answer2 = "unsupported";
					if (cancel) try {
						answer2 = await call(row, drive, (ctx) => cancel(ref(row), ctx));
					} catch (error) {
						if (error instanceof StoppedError || error instanceof DeadlineError) return;
						await transition(row, {
							...failurePatch(row, error, "running"),
							cancel_failed_at: now()
						});
						return;
					}
					if (answer2 !== "cancelled" && answer2 !== "requested" && answer2 !== "unsupported") {
						await transition(row, {
							...failurePatch(row, invalidResponse("cancel answer"), "running"),
							cancel_failed_at: now()
						});
						return;
					}
					await transition(row, answer2 === "cancelled" ? {
						state: "cancelled",
						cancel_sent_at: now()
					} : {
						cancel_sent_at: now(),
						attempt: 0
					});
					return;
				}
				let polled;
				try {
					polled = await call(row, drive, (ctx) => provider.poll(ref(row), ctx));
				} catch (error) {
					if (error instanceof StoppedError || error instanceof DeadlineError) return;
					if (error instanceof OperationError && !error.retryable) {
						const failure = describeFailure(error);
						await transition(row, {
							state: "failed",
							error_code: failure.code,
							error_message: failure.message
						});
						return;
					}
					await transition(row, failurePatch(row, error, "running"));
					return;
				}
				if (!isRecord(polled) || !POLL_STATUSES.has(polled.status)) {
					await transition(row, failurePatch(row, invalidResponse("poll answer"), "running"));
					return;
				}
				const answer = polled;
				if (answer.status === "running") {
					const checkpoint = answer.checkpoint === void 0 ? row.checkpoint : encodeCheckpoint(answer.checkpoint);
					if (checkpoint === void 0) {
						await transition(row, checkpointRejected(row.provider_id ?? ""));
						return;
					}
					const progress = isRecord(answer.progress) ? answer.progress : void 0;
					const fraction = progress?.fraction;
					await transition(row, {
						checkpoint,
						progress: progress === void 0 ? row.progress : JSON.stringify({
							fraction: typeof fraction === "number" && Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : null,
							...typeof progress.detail === "string" && progress.detail.trim() ? { detail: oneLine(progress.detail, 200, "") } : {}
						}),
						attempt: 0,
						error_code: null,
						error_message: null,
						next_attempt_at: now() + (typeof answer.nextPollMs === "number" && Number.isFinite(answer.nextPollMs) ? Math.max(0, answer.nextPollMs) : pollInterval(row.kind))
					});
				} else if (answer.status === "succeeded") {
					let result = null;
					let error = null;
					if (answer.result !== void 0) try {
						result = encodeJson(answer.result, OPERATION_RESULT_MAX_CHARS, "result");
					} catch {
						error = {
							code: "RESULT_NOT_STORED",
							message: "The provider's result was too large or not JSON, so it was not kept"
						};
					}
					await transition(row, {
						state: "succeeded",
						result,
						progress: JSON.stringify({ fraction: 1 }),
						error_code: error?.code ?? null,
						error_message: error?.message ?? null
					});
				} else if (answer.status === "failed") await transition(row, {
					state: "failed",
					error_code: oneLine(String(answer.code ?? "PROVIDER_FAILED"), 64, "PROVIDER_FAILED"),
					error_message: oneLine(String(answer.message ?? ""), 500, "The provider reported a failure")
				});
				else await transition(row, { state: "cancelled" });
				return;
			}
			default: return;
		}
	};
	const reportProgress = (task, row) => {
		const progress = parseJson(row.progress);
		const detail = row.cancel_requested_at !== null ? "Cancel requested; waiting for the provider" : progress?.detail ?? "";
		try {
			task.report({
				fraction: progress?.fraction ?? null,
				detail
			});
		} catch {}
	};
	const release = async (drive, result) => {
		if (drive.released || !drive.task) return;
		drive.released = true;
		await drive.task.finish(result).catch(() => {});
	};
	const finishTask = (drive, row) => {
		if (row.state === "succeeded") return release(drive, { outcome: "succeeded" });
		if (row.state === "cancelled") return release(drive, { outcome: "cancelled" });
		return release(drive, {
			outcome: "failed",
			message: oneLine(row.error_message ?? "", PLUGIN_TASK_MESSAGE_MAX, row.state === "abandoned" ? "Stopped tracking the operation" : "The operation failed")
		});
	};
	const isInterrupted = (task) => task.signal.aborted && task.signal.reason?.cause !== "cancelled";
	const driveOperation = async (id, drive) => {
		let row = await load(id);
		if (!row || TERMINAL.has(row.state) || drive.stop.signal.aborted) return;
		const task = await host.tasks.start({
			title: oneLine(row.title, 120, "Operation"),
			cancellable: true,
			retry: {
				actionId: options.retryActionId,
				args: { operationId: id }
			}
		});
		drive.task = task;
		const onAbort = () => {
			if (!isInterrupted(task)) {
				manager.cancel(id).catch(() => {});
				return;
			}
			suspended = true;
			for (const entry of driving.values()) entry.stop.abort();
		};
		if (task.signal.aborted) onAbort();
		else task.signal.addEventListener("abort", onAbort, { once: true });
		try {
			while (!drive.stop.signal.aborted) {
				row = await load(id);
				if (!row) return;
				if (TERMINAL.has(row.state)) {
					await finishTask(drive, row);
					prune().catch(() => {});
					return;
				}
				reportProgress(task, row);
				if (now() >= row.deadline_at) {
					await transition(row, row.state === "pending" && row.submitted_at === null ? {
						state: "failed",
						error_code: "DEADLINE_EXCEEDED",
						error_message: "Not submitted before its deadline"
					} : {
						state: "abandoned",
						error_code: "DEADLINE_EXCEEDED",
						error_message: "Stopped tracking at its deadline; the provider's outcome is unknown"
					});
					continue;
				}
				const due = row.state === "running" && row.cancel_requested_at !== null && row.cancel_sent_at === null && row.cancel_failed_at === null ? 0 : row.next_attempt_at - now();
				if (due > 0) {
					await waitFor(Math.min(due, row.deadline_at - now()), drive);
					continue;
				}
				await step(row, drive);
			}
		} finally {
			task.signal.removeEventListener("abort", onAbort);
			if (!isInterrupted(task)) await release(drive, { outcome: "cancelled" });
		}
	};
	const schedulePump = (delayMs) => {
		if (disposed || pumpTimer) return;
		pumpTimer = setTimeout(() => {
			pumpTimer = null;
			pump();
		}, delayMs);
	};
	const pump = () => {
		if (disposed || suspended || !db) return;
		if (pumping) {
			pumpAgain = true;
			return;
		}
		pumping = true;
		pumpRun = (async () => {
			try {
				do {
					pumpAgain = false;
					if (concurrency - driving.size <= 0) break;
					const rows = await requireDb().query(`SELECT id FROM operations WHERE state NOT IN (${TERMINAL_SQL})
             ORDER BY next_attempt_at, created_at LIMIT ?`, [concurrency + driving.size]);
					for (const { id } of rows) {
						if (disposed || suspended || driving.size >= concurrency) break;
						if (driving.has(id)) continue;
						const entry = {
							stop: new AbortController(),
							task: null,
							released: false,
							failed: false,
							wake: () => {}
						};
						driving.set(id, entry);
						const run = driveOperation(id, entry).catch(() => {
							entry.failed = true;
							schedulePump(TASK_START_RETRY_MS);
						}).finally(() => {
							driving.delete(id);
							runs.delete(run);
							if (!entry.failed) pump();
						});
						runs.add(run);
					}
				} while (pumpAgain && !disposed && !suspended);
			} catch {
				schedulePump(TASK_START_RETRY_MS);
			} finally {
				pumping = false;
			}
		})();
	};
	const resume = () => {
		suspended = false;
		pump();
	};
	const prune = async () => {
		const handle = requireDb();
		const byAge = await handle.run(`DELETE FROM operations WHERE state IN (${TERMINAL_SQL}) AND updated_at < ?`, [now() - retentionAgeMs]);
		const byCount = await handle.run(`DELETE FROM operations WHERE id IN (
         SELECT id FROM operations WHERE state IN (${TERMINAL_SQL})
         ORDER BY updated_at DESC, created_at DESC LIMIT -1 OFFSET ?
       )`, [retentionCount]);
		return byAge.changes + byCount.changes;
	};
	const ready = () => {
		if (disposed) return Promise.reject(/* @__PURE__ */ new Error("operation manager is disposed"));
		if (!starting) starting = (async () => {
			const opened = await host.db.open(options.database, { migrations: MIGRATIONS$1 });
			if (disposed) {
				await opened.close();
				throw new Error("operation manager is disposed");
			}
			db = opened;
			await db.run("UPDATE operations SET state = 'uncertain', updated_at = ? WHERE state = 'submitting'", [now()]);
			await prune();
		})().catch(async (error) => {
			starting = null;
			const handle = db;
			db = null;
			await handle?.close().catch(() => {});
			throw error;
		});
		return starting;
	};
	const manager = {
		start() {
			return ready().then(resume);
		},
		async submit(kind, input, submitOptions = {}) {
			await ready();
			const def = kindOf(kind);
			const inputJson = encodeJson(input, OPERATION_INPUT_MAX_CHARS, "operation input");
			const key = submitOptions.idempotencyKey ?? globalThis.crypto.randomUUID();
			if (typeof key !== "string" || key.length === 0 || key.length > 256) throw new RangeError(`idempotencyKey must be a non-empty string of at most 256 characters`);
			const hash = await sha256Hex(`${kind}
${canonicalJson(JSON.parse(inputJson))}`);
			const title = oneLine(String(def.title(JSON.parse(inputJson))), 120, kind);
			const createdAt = now();
			const row = await requireDb().transaction(async (tx) => {
				const existing = await tx.get("SELECT * FROM operations WHERE idempotency_key = ?", [key]);
				if (existing) {
					if (existing.request_hash !== hash || existing.kind !== kind) throw new OperationConflictError(existing.id);
					return existing;
				}
				if (((await tx.get(`SELECT COUNT(*) AS n FROM operations WHERE state NOT IN (${TERMINAL_SQL})`))?.n ?? 0) >= maxUnfinished) throw new OperationCapacityError(maxUnfinished);
				const id = globalThis.crypto.randomUUID();
				await tx.run(`INSERT INTO operations (id, kind, idempotency_key, request_hash, project_id, title,
             input, state, attempt, next_attempt_at, deadline_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`, [
					id,
					kind,
					key,
					hash,
					submitOptions.projectId ?? null,
					title,
					inputJson,
					createdAt,
					createdAt + deadlineFor(kind),
					createdAt,
					createdAt
				]);
				return await load(id, tx);
			});
			resume();
			return toSnapshot(row);
		},
		async get(id) {
			await ready();
			const row = await load(id);
			return row ? toSnapshot(row) : void 0;
		},
		async list(filter = {}) {
			await ready();
			const where = [];
			const params = [];
			if (filter.projectId === null) where.push("project_id IS NULL");
			else if (filter.projectId !== void 0) {
				where.push("project_id = ?");
				params.push(filter.projectId);
			}
			if (filter.states) {
				if (filter.states.length === 0) return [];
				where.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
				params.push(...filter.states);
			}
			const limit = Math.min(100, Math.max(1, Math.floor(positiveNumber(filter.limit, 100))));
			return (await requireDb().query(`SELECT * FROM operations ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC, id LIMIT ?`, [...params, limit])).map(toSnapshot);
		},
		async cancel(id) {
			await ready();
			const handle = requireDb();
			const at = now();
			const cancelled = await handle.run(`UPDATE operations SET state = 'cancelled', cancel_requested_at = ?, updated_at = ?
         WHERE id = ? AND state = 'pending' AND submitted_at IS NULL`, [
				at,
				at,
				id
			]);
			await handle.run(`UPDATE operations SET cancel_requested_at = ?, updated_at = ?
         WHERE id = ? AND cancel_requested_at IS NULL AND state NOT IN (${TERMINAL_SQL})`, [
				at,
				at,
				id
			]);
			if (cancelled.changes > 0) prune().catch(() => {});
			driving.get(id)?.wake();
			pump();
			return manager.get(id);
		},
		async retry(id) {
			await ready();
			const row = await load(id);
			if (!row) return void 0;
			const at = now();
			if (row.state === "abandoned") {
				const state = row.provider_id !== null ? "running" : row.submitted_at !== null ? "uncertain" : "pending";
				await requireDb().run(`UPDATE operations SET state = ?, generation = generation + 1, attempt = 0,
             next_attempt_at = ?, deadline_at = ?, cancel_requested_at = NULL,
             cancel_sent_at = NULL, cancel_failed_at = NULL, error_code = NULL,
             error_message = NULL, updated_at = ?
           WHERE id = ? AND state = 'abandoned'`, [
					state,
					at,
					at + deadlineFor(row.kind),
					at,
					id
				]);
			} else if (!TERMINAL.has(row.state)) {
				await requireDb().run("UPDATE operations SET next_attempt_at = ?, updated_at = ? WHERE id = ? AND next_attempt_at > ?", [
					at,
					at,
					id,
					at
				]);
				driving.get(id)?.wake();
			}
			resume();
			return manager.get(id);
		},
		async abandon(id) {
			await ready();
			if ((await requireDb().run(`UPDATE operations SET state = 'abandoned', generation = generation + 1,
           error_code = 'ABANDONED',
           error_message = 'Stopped tracking on request; the provider''s outcome is unknown',
           updated_at = ?
         WHERE id = ? AND state NOT IN (${TERMINAL_SQL})`, [now(), id])).changes > 0) prune().catch(() => {});
			driving.get(id)?.wake();
			return manager.get(id);
		},
		async prune() {
			await ready();
			return prune();
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			if (pumpTimer) clearTimeout(pumpTimer);
			pumpTimer = null;
			for (const entry of driving.values()) entry.stop.abort();
			await pumpRun;
			for (const entry of driving.values()) entry.stop.abort();
			await Promise.allSettled([...runs]);
			await starting?.catch(() => {});
			const handle = db;
			db = null;
			await handle?.close();
		}
	};
	return manager;
}
var STATUS_LABELS = {
	open: "Open",
	in_progress: "In progress",
	done: "Done"
};
function escapeXml(text) {
	return text.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
/**
* The report the synthetic provider "builds": a small SVG summary of the
* requests it was given. Deterministic, so a reconciled job that rebuilds it
* writes the same bytes.
*/
function renderReportSvg(requests, generatedAt) {
	const counts = REQUEST_STATUSES.map((status) => ({
		status,
		count: requests.filter((request) => request.status === status).length
	}));
	const max = Math.max(1, ...counts.map((entry) => entry.count));
	const bars = counts.map((entry, index) => {
		const y = 56 + index * 36;
		const width = Math.round(entry.count / max * 220);
		return `<text x="16" y="${y + 16}" font-size="13">${STATUS_LABELS[entry.status]}</text>
  <rect x="112" y="${y}" width="${width}" height="22" rx="4" fill="#5b8def" />
  <text x="${120 + width}" y="${y + 16}" font-size="13">${entry.count}</text>`;
	}).join("\n  ");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="190" viewBox="0 0 400 190" font-family="system-ui, sans-serif" fill="#1f2328">
  <rect width="400" height="190" fill="#ffffff" />
  <text x="16" y="30" font-size="16" font-weight="600">Request Desk report</text>
  <text x="16" y="46" font-size="11" fill="#57606a">${escapeXml(`${requests.length} requests · ${generatedAt}`)}</text>
  ${bars}
</svg>
`;
}
var REPORT_REQUEST_LIMIT = 500;
/**
* A stand-in for a remote report API, shaped like a real one: it accepts a
* job, answers polls until the job is done, can be asked whether it already
* has a job for an idempotency key, and can be asked to cancel. Its jobs live
* in the project database rather than in memory, so a worker restart in the
* middle of a build finds the job again exactly as a real provider would.
* Swap this object for your provider's client; nothing else changes.
*/
function syntheticReportKind(deps) {
	const now = deps.now ?? Date.now;
	const buildMs = deps.buildMs ?? 6e3;
	async function jobBy(column, value) {
		return await (await deps.openStore()).db.get(`SELECT * FROM provider_jobs WHERE ${column} = ?`, [value]);
	}
	return {
		title: (input) => input.requestedBy === "agent" ? "Building a report for an agent" : "Building a report",
		pollIntervalMs: deps.pollIntervalMs ?? 1e3,
		deadlineMs: 10 * 6e4,
		provider: {
			async submit(_input, { idempotencyKey }) {
				if (!await deps.workspace()) throw new OperationError("NOT_CONNECTED", "Connect the report provider in Request Desk's settings, then build the report again.", { retryable: false });
				const existing = await jobBy("idempotency_key", idempotencyKey);
				if (existing) return { providerId: existing.provider_id };
				const providerId = `job-${crypto.randomUUID()}`;
				const at = now();
				await (await deps.openStore()).db.run("INSERT INTO provider_jobs (idempotency_key, provider_id, submitted_at, ready_at) VALUES (?, ?, ?, ?)", [
					idempotencyKey,
					providerId,
					at,
					at + buildMs
				]);
				return { providerId };
			},
			async poll({ providerId }) {
				const job = await jobBy("provider_id", providerId);
				if (!job) return {
					status: "failed",
					message: "The provider has no record of this report."
				};
				if (job.cancelled) return { status: "cancelled" };
				const store = await deps.openStore();
				if (job.report_id) {
					const report = await store.db.get("SELECT request_count FROM reports WHERE id = ?", [job.report_id]);
					return {
						status: "succeeded",
						result: {
							reportId: job.report_id,
							requestCount: report?.request_count ?? 0
						}
					};
				}
				const at = now();
				if (at < job.ready_at) {
					const span = Math.max(1, job.ready_at - job.submitted_at);
					return {
						status: "running",
						progress: { fraction: Math.min(.95, (at - job.submitted_at) / span) }
					};
				}
				const requests = await store.snapshot(REPORT_REQUEST_LIMIT);
				const reportId = `report-${job.provider_id.slice(4, 12)}`;
				const path = await deps.writeReport(reportId, renderReportSvg(requests, new Date(job.ready_at).toISOString()));
				await store.db.transaction(async (tx) => {
					await tx.run("INSERT OR REPLACE INTO reports (id, path, request_count, created_at) VALUES (?, ?, ?, ?)", [
						reportId,
						path,
						requests.length,
						new Date(at).toISOString()
					]);
					await tx.run("UPDATE provider_jobs SET report_id = ? WHERE provider_id = ?", [reportId, providerId]);
				});
				return {
					status: "succeeded",
					result: {
						reportId,
						requestCount: requests.length
					}
				};
			},
			async reconcile(_input, { idempotencyKey }) {
				const job = await jobBy("idempotency_key", idempotencyKey);
				return job ? {
					status: "found",
					providerId: job.provider_id
				} : { status: "not-found" };
			},
			async cancel({ providerId }) {
				const { changes } = await (await deps.openStore()).db.run("UPDATE provider_jobs SET cancelled = 1 WHERE provider_id = ? AND report_id IS NULL", [providerId]);
				return changes > 0 ? "cancelled" : "requested";
			}
		}
	};
}
var DATABASE_ID = "requests";
var MAX_PAGE = 100;
/**
* Append only: the host runs migration n when the file's `user_version` is n,
* and `plugin.json` declares `schemaVersion` as this list's length. The demo
* records are a migration rather than an "if empty" check on start, so they
* arrive exactly once: a user who deletes them never sees them come back.
*/
var MIGRATIONS = [
	`CREATE TABLE requests (
     id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
     title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (${REQUEST_STATUSES.map((s) => `'${s}'`).join(", ")})),
     notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= ${MAX_NOTES_CHARS}),
     revision INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   ) STRICT;
   CREATE INDEX requests_by_status ON requests (status, updated_at DESC);`,
	`INSERT INTO requests (id, title, status, notes, created_at, updated_at) VALUES
     ('demo-1', 'Add dark mode to the invoice page', 'open', 'Synthetic demo record.', '2026-01-05T09:00:00.000Z', '2026-01-05T09:00:00.000Z'),
     ('demo-2', 'Export customers as CSV', 'in_progress', 'Synthetic demo record.', '2026-01-06T10:30:00.000Z', '2026-01-07T14:00:00.000Z'),
     ('demo-3', 'Fix the broken password reset link', 'done', 'Synthetic demo record.', '2026-01-02T16:45:00.000Z', '2026-01-03T11:20:00.000Z');`,
	`CREATE TABLE provider_jobs (
     idempotency_key TEXT PRIMARY KEY,
     provider_id TEXT NOT NULL UNIQUE,
     submitted_at INTEGER NOT NULL,
     ready_at INTEGER NOT NULL,
     cancelled INTEGER NOT NULL DEFAULT 0,
     report_id TEXT
   ) STRICT;
   CREATE TABLE reports (
     id TEXT PRIMARY KEY,
     path TEXT NOT NULL,
     request_count INTEGER NOT NULL,
     created_at TEXT NOT NULL
   ) STRICT;`
];
function toRecord(row) {
	return {
		id: row.id,
		title: row.title,
		status: row.status,
		notes: row.notes,
		revision: row.revision,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}
function isRequestStatus(value) {
	return typeof value === "string" && REQUEST_STATUSES.includes(value);
}
/** Thrown for input a caller can fix; its message is written for them. */
var RequestInputError = class extends Error {};
function cleanTitle(value) {
	if (typeof value !== "string" || value.trim().length === 0) throw new RequestInputError("A request needs a title.");
	const title = value.trim();
	if (title.length > 120) throw new RequestInputError(`A title is at most 120 characters.`);
	return title;
}
function cleanNotes(value) {
	if (value === void 0) return "";
	if (typeof value !== "string") throw new RequestInputError("Notes must be text.");
	if (value.length > 2e3) throw new RequestInputError(`Notes are at most ${MAX_NOTES_CHARS} characters.`);
	return value;
}
/**
* Open lazily, from the first handler or tool that needs it: a project
* database asks the user for write consent the first time, and activation must
* not wait on a prompt. The promise is kept so every caller shares one open,
* and dropped on failure so a declined prompt can be asked again.
*/
function createStoreOpener(host, onOpen) {
	let opening;
	return () => opening ??= host.db.open(DATABASE_ID, { migrations: MIGRATIONS }).then((db) => {
		const store = createStore(db);
		onOpen(store);
		return store;
	}).catch((error) => {
		opening = void 0;
		throw error;
	});
}
function createStore(db, now = () => /* @__PURE__ */ new Date()) {
	const stamp = () => now().toISOString();
	async function get(id) {
		const row = await db.get("SELECT * FROM requests WHERE id = ?", [id]);
		return row ? toRecord(row) : null;
	}
	return {
		db,
		get,
		async list(filter = {}) {
			const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? 50)), MAX_PAGE);
			return (filter.status ? await db.query("SELECT * FROM requests WHERE status = ? ORDER BY updated_at DESC, id LIMIT ?", [filter.status, limit]) : await db.query("SELECT * FROM requests ORDER BY updated_at DESC, id LIMIT ?", [limit])).map(toRecord);
		},
		async add(input) {
			const title = cleanTitle(input.title);
			const notes = cleanNotes(input.notes);
			const id = input.id ?? `req-${crypto.randomUUID().slice(0, 8)}`;
			const at = stamp();
			const existing = await get(id);
			if (existing) return existing;
			await db.run("INSERT INTO requests (id, title, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
				id,
				title,
				notes,
				at,
				at
			]);
			return await get(id);
		},
		async update(args) {
			const current = await get(args.id);
			if (!current) return {
				ok: false,
				reason: "not-found"
			};
			if (current.revision !== args.revision) return {
				ok: false,
				reason: "conflict",
				current
			};
			if (args.status !== void 0 && !isRequestStatus(args.status)) throw new RequestInputError(`Status must be one of ${REQUEST_STATUSES.join(", ")}.`);
			const title = args.title === void 0 ? current.title : cleanTitle(args.title);
			const notes = args.notes === void 0 ? current.notes : cleanNotes(args.notes);
			const { changes } = await db.run(`UPDATE requests SET title = ?, status = ?, notes = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND revision = ?`, [
				title,
				args.status ?? current.status,
				notes,
				stamp(),
				args.id,
				args.revision
			]);
			const after = await get(args.id);
			if (!after) return {
				ok: false,
				reason: "not-found"
			};
			if (changes === 0) return {
				ok: false,
				reason: "conflict",
				current: after
			};
			return {
				ok: true,
				request: after
			};
		},
		async snapshot(limit) {
			return (await db.query("SELECT * FROM requests ORDER BY status, updated_at DESC, id LIMIT ?", [limit])).map(toRecord);
		}
	};
}
/** The `contributes.agentMcp` endpoint the tools below are served on. */
var ENDPOINT_ID = "requests";
var WORKSPACE_SETTING = "providerWorkspace";
/**
* Request Desk's worker. Everything durable lives here rather than in a view:
* the store, the report operations and the artifact handles. Views come and go
* (switching Home to Grid unmounts one) and only ask the worker for data.
*
* Nothing here spells the plugin's own name. Qualified ids are built from
* `host.pluginInfo.manifestId`, so the scaffold can copy this build under any
* name without rebuilding it.
*/
async function activate(host) {
	const { manifestId, projectRoot } = host.pluginInfo;
	const disposers = [];
	let disposed = false;
	const push = (channel) => {
		if (!disposed) host.postToPanel(channel, null).catch(() => {});
	};
	const openStore = createStoreOpener(host, (store) => {
		disposers.push(store.db.onDidChange(() => push(EVENTS.requestsChanged)));
	});
	const workspace = async () => {
		const value = await host.settings.get(WORKSPACE_SETTING);
		return typeof value === "string" && value.trim() ? value.trim() : null;
	};
	const writeReport = async (reportId, svg) => {
		if (!projectRoot) throw new Error("Request Desk runs only inside its project.");
		const dir = `${projectRoot}/.daintree/data/${manifestId}/reports`;
		await host.fs.mkdir(dir);
		const path = `${dir}/${reportId}.svg`;
		await host.fs.writeFile(path, svg);
		return path;
	};
	const operations = createOperationManager({
		tasks: host.tasks,
		db: { open: async (id, options) => {
			const handle = await host.db.open(id, options);
			disposers.push(handle.onDidChange(() => push(EVENTS.reportsChanged)));
			return handle;
		} }
	}, {
		database: "operations",
		retryActionId: `${manifestId}.resume-report`,
		kinds: { report: syntheticReportKind({
			openStore,
			workspace,
			writeReport
		}) }
	});
	const artifactIds = /* @__PURE__ */ new Map();
	const reportArtifact = async (reportId) => {
		const known = artifactIds.get(reportId);
		if (known) {
			const live = await host.artifacts.stat(known);
			if (live) return live;
			artifactIds.delete(reportId);
		}
		const row = await (await openStore()).db.get("SELECT path FROM reports WHERE id = ?", [reportId]);
		if (!row) return null;
		const artifact = await host.artifacts.import({ path: row.path }, {
			name: `${reportId}.svg`,
			mimeType: "image/svg+xml"
		});
		artifactIds.set(reportId, artifact.id);
		return artifact;
	};
	const summarize = (op) => {
		const result = op.result;
		return {
			operationId: op.id,
			state: op.state,
			reportId: result?.reportId ?? null,
			requestCount: result?.requestCount ?? null,
			fraction: op.progress?.fraction ?? null,
			error: op.error?.message ?? null,
			createdAt: op.createdAt
		};
	};
	const startReport = async (requestedBy, key) => {
		const op = await operations.submit("report", { requestedBy }, { idempotencyKey: key ?? `report:${requestedBy}:${crypto.randomUUID()}` });
		push(EVENTS.reportsChanged);
		return summarize(op);
	};
	const resumeReport = async (operationId) => {
		if (typeof operationId !== "string") return null;
		const op = await operations.retry(operationId);
		push(EVENTS.reportsChanged);
		return op ? summarize(op) : null;
	};
	const connection = async () => {
		const ws = await workspace();
		return {
			connected: ws !== null,
			workspace: ws
		};
	};
	await host.registerHandler(CHANNELS.list, async (_ctx, args) => {
		const { status } = args ?? {};
		return (await openStore()).list({ status: isRequestStatus(status) ? status : void 0 });
	});
	await host.registerHandler(CHANNELS.get, async (_ctx, args) => {
		const { id } = args ?? {};
		return typeof id === "string" ? (await openStore()).get(id) : null;
	});
	await host.registerHandler(CHANNELS.add, async (_ctx, args) => {
		const { title, notes } = args ?? {};
		return (await openStore()).add({
			title,
			notes
		});
	});
	await host.registerHandler(CHANNELS.update, async (_ctx, args) => (await openStore()).update(args));
	await host.registerHandler(CHANNELS.reports, async () => (await operations.list({ limit: 20 })).map(summarize));
	await host.registerHandler(CHANNELS.startReport, async (_ctx, args) => {
		const { key } = args ?? {};
		return startReport("view", typeof key === "string" ? key : void 0);
	});
	await host.registerHandler(CHANNELS.retryReport, async (_ctx, args) => resumeReport(args?.operationId));
	await host.registerHandler(CHANNELS.reportArtifact, async (_ctx, args) => {
		const { reportId } = args ?? {};
		return typeof reportId === "string" ? reportArtifact(reportId) : null;
	});
	await host.registerHandler(CHANNELS.connection, connection);
	await host.registerHandler(CHANNELS.connect, async (_ctx, args) => {
		const { workspace: name } = args ?? {};
		const value = typeof name === "string" && name.trim() ? name.trim().slice(0, 64) : "Demo workspace";
		await host.settings.set(WORKSPACE_SETTING, value);
		return connection();
	});
	await host.registerHandler(CHANNELS.testConnection, async () => {
		const ws = await workspace();
		return ws ? {
			ok: true,
			message: `Reached ${ws}. The synthetic provider answers offline.`
		} : {
			ok: false,
			message: "Not connected. Connect a workspace first."
		};
	});
	await host.registerHandler(CHANNELS.disconnect, async () => {
		await host.settings.unset(WORKSPACE_SETTING);
		return connection();
	});
	disposers.push(await host.settings.onDidChange(WORKSPACE_SETTING, () => push(EVENTS.connectionChanged)));
	const tools = {
		list_requests: {
			description: "List this project's Request Desk requests, most recently changed first. Each has an id, title, status, notes and a revision to pass to update_request.",
			inputSchema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: [...REQUEST_STATUSES]
					},
					limit: {
						type: "integer",
						minimum: 1,
						maximum: 100
					}
				},
				additionalProperties: false
			},
			async execute(args) {
				const status = isRequestStatus(args.status) ? args.status : void 0;
				const limit = typeof args.limit === "number" ? args.limit : void 0;
				return { requests: await (await openStore()).list({
					status,
					limit
				}) };
			}
		},
		add_request: {
			description: "Add a request. Pass the same id again to retry a call that timed out: it returns the request already made instead of a duplicate.",
			inputSchema: {
				type: "object",
				properties: {
					title: {
						type: "string",
						minLength: 1,
						maxLength: 120
					},
					notes: {
						type: "string",
						maxLength: MAX_NOTES_CHARS
					},
					id: {
						type: "string",
						pattern: "^[a-z0-9-]{1,64}$"
					}
				},
				required: ["title"],
				additionalProperties: false
			},
			async execute(args) {
				const id = typeof args.id === "string" ? args.id : void 0;
				return { request: await (await openStore()).add({
					title: args.title,
					notes: args.notes,
					id
				}) };
			}
		},
		update_request: {
			description: "Change a request's title, status or notes. Pass the revision you last read; if someone changed it since, nothing is written and the current request comes back so you can decide again.",
			inputSchema: {
				type: "object",
				properties: {
					id: {
						type: "string",
						maxLength: 64
					},
					revision: {
						type: "integer",
						minimum: 1
					},
					title: {
						type: "string",
						minLength: 1,
						maxLength: 120
					},
					status: {
						type: "string",
						enum: [...REQUEST_STATUSES]
					},
					notes: {
						type: "string",
						maxLength: MAX_NOTES_CHARS
					}
				},
				required: ["id", "revision"],
				additionalProperties: false
			},
			async execute(args) {
				try {
					return await (await openStore()).update(args);
				} catch (error) {
					if (error instanceof RequestInputError) return {
						ok: false,
						reason: error.message
					};
					throw error;
				}
			}
		},
		generate_report: {
			description: "Start building a report of every request. Returns at once with an operationId; the report builds in the background, so call get_report with it until state is succeeded or failed.",
			inputSchema: {
				type: "object",
				properties: { key: {
					type: "string",
					maxLength: 128
				} },
				additionalProperties: false
			},
			async execute(args) {
				return startReport("agent", typeof args.key === "string" ? `agent:${args.key}` : void 0);
			}
		},
		get_report: {
			description: "Read the state of a report started with generate_report.",
			inputSchema: {
				type: "object",
				properties: { operationId: {
					type: "string",
					maxLength: 128
				} },
				required: ["operationId"],
				additionalProperties: false
			},
			async execute(args) {
				const op = await operations.get(String(args.operationId));
				return op ? summarize(op) : {
					state: "unknown",
					operationId: args.operationId
				};
			}
		}
	};
	disposers.push(await host.mcp.registerTools(ENDPOINT_ID, tools));
	await host.registerAction({
		id: "first-request",
		title: "Try Request Desk with an agent",
		description: "Choose an agent and put a first Request Desk task in its draft.",
		category: "Request Desk",
		kind: "command",
		danger: "safe"
	}, async () => {
		const result = await host.sendToAgent([
			"Use the Request Desk tools (list_requests, add_request, update_request) for this project.",
			"1. List the open requests.",
			"2. Add a request titled \"Write the onboarding checklist\".",
			"3. Move the oldest open request to in_progress, with a one-line note on what you'd do first.",
			"Request Desk's list updates as each tool call lands."
		].join("\n"), { title: "Try Request Desk" });
		if (result.status === "refused") await host.showToast({
			message: `The task couldn't be drafted (${result.reason}).`,
			type: "warning"
		});
		return result;
	});
	await host.registerAction({
		id: "open-connection",
		title: "Connect the report provider",
		description: "Open the Request Desk connection page in Project settings.",
		category: "Request Desk",
		kind: "command",
		danger: "safe"
	}, async () => host.dispatch("plugin.openSettings", {
		pluginId: manifestId,
		section: "custom",
		page: "connection"
	}));
	await host.registerAction({
		id: "resume-report",
		title: "Resume report",
		description: "Pick up a report the provider may still be building.",
		category: "Request Desk",
		kind: "command",
		danger: "safe"
	}, async (args) => resumeReport(args?.operationId));
	await operations.start();
	return () => {
		disposed = true;
		for (const dispose of disposers.splice(0)) dispose();
		operations.dispose().catch(() => {});
	};
}
export { activate };
