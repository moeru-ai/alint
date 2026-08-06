#!/usr/bin/env node
import process$1, { cwd } from "node:process";
import { closeSync, constants, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { Buffer as Buffer$1 } from "node:buffer";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, normalize, resolve } from "node:path";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { PassThrough } from "node:stream";
import u from "node:readline";
import { randomUUID } from "node:crypto";
//#region ../../node_modules/.pnpm/@moeru+std@0.1.0-beta.20/node_modules/@moeru/std/dist/error/index.js
const isError = (err) => {
	if ("isError" in Error && Error.isError(new DOMException())) return Error.isError(err);
	if (err === null || typeof err !== "object" && typeof err !== "function") return false;
	if (err instanceof Error) return true;
	const tag = Object.prototype.toString.call(err);
	return tag === "[object DOMException]" || tag === "[object Error]";
};
const isErrorLike = (err) => {
	if (isError(err)) return true;
	if (err == null || typeof err !== "object" && typeof err !== "function") return false;
	return "message" in err && typeof err.message === "string" && "name" in err && typeof err.name === "string";
};
const errorMessageFrom = (err) => isErrorLike(err) ? err.message : err == null ? void 0 : String(err);
//#endregion
//#region src/fatal-diagnostic.ts
const budgetBytes = 10485760;
const directory = join(tmpdir(), "alint-stop-gate", "fatal");
const truncationMarker = "\nNOTICE: fatal diagnostic truncated to fit the 10 MiB budget.\n";
function writeFatalDiagnostic(context, detail) {
	const timestamp = (/* @__PURE__ */ new Date()).toISOString();
	const fileName = `${timestamp.replaceAll(":", "-").replaceAll(".", "-")}-${process$1.pid}.log`;
	const path = join(directory, fileName);
	try {
		mkdirSync(directory, {
			mode: 448,
			recursive: true
		});
		writeFileSync(path, diagnosticContent(timestamp, context, detail), {
			flag: "wx",
			mode: 384
		});
	} catch (error) {
		return { writeError: errorMessageFrom(error) ?? "unknown error" };
	}
	try {
		enforceBudget();
		return { path };
	} catch (error) {
		return {
			cleanupError: errorMessageFrom(error) ?? "unknown error",
			path
		};
	}
}
function diagnosticContent(timestamp, context, detail) {
	const content = Buffer$1.from(`timestamp: ${timestamp}\ncontext: ${context}\ndetail: ${detail}\n`);
	if (content.byteLength <= budgetBytes) return content;
	const marker = Buffer$1.from(truncationMarker);
	return Buffer$1.concat([content.subarray(0, budgetBytes - marker.byteLength), marker]);
}
function enforceBudget() {
	const diagnostics = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".log")).map((entry) => {
		const path = join(directory, entry.name);
		const stats = statSync(path);
		return {
			mtimeMs: stats.mtimeMs,
			path,
			size: stats.size
		};
	});
	let total = diagnostics.reduce((sum, diagnostic) => sum + diagnostic.size, 0);
	for (const diagnostic of diagnostics.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
		if (total <= budgetBytes) break;
		unlinkSync(diagnostic.path);
		total -= diagnostic.size;
	}
}
//#endregion
//#region src/policy.ts
const maximumLintRounds = 9;
function applyResult(state, envelope, now = /* @__PURE__ */ new Date()) {
	if (envelope.status === "inactive" || envelope.status === "no-dirty-files") return {
		decision: {},
		state: envelope.status === "inactive" ? updateState(state, now, {
			lastFindings: void 0,
			lintRounds: 0,
			runtimeFailures: 0
		}) : updateState(state, now, {
			lastFindings: void 0,
			runtimeFailures: 0
		})
	};
	if (envelope.status === "runtime-error") {
		const next = updateState(state, now, {
			lastFindings: void 0,
			runtimeFailures: state.runtimeFailures + 1
		});
		const message = envelope.message ?? "alint Stop Gate failed with an unknown runtime error.";
		return {
			decision: next.runtimeFailures === 1 ? {
				decision: "block",
				reason: runtimeFailureMessage(message)
			} : { systemMessage: runtimeFailureMessage(message) },
			state: next
		};
	}
	const lintRounds = state.lintRounds + 1;
	const repeatedFindings = envelope.status === "errors" || envelope.status === "warnings" ? state.lastFindings?.findingsHash === requiredFindingsHash(envelope) : false;
	const next = updateState(state, now, {
		lastFindings: envelope.status === "errors" || envelope.status === "warnings" ? {
			errorCount: envelope.errorCount,
			findingsHash: requiredFindingsHash(envelope),
			reportPath: requiredReportPath(envelope),
			status: envelope.status,
			warningCount: envelope.warningCount
		} : void 0,
		lintRounds,
		runtimeFailures: 0
	});
	if (envelope.status === "clean") return {
		decision: {},
		state: next
	};
	const message = findingMessage(next, requiredReportPath(envelope));
	return {
		decision: (envelope.status === "errors" ? lintRounds < maximumLintRounds && !repeatedFindings : lintRounds === 1) ? {
			decision: "block",
			reason: message
		} : { systemMessage: repeatedFindings ? repeatedFindingsMessage(next, requiredReportPath(envelope)) : message },
		state: next
	};
}
function hasReachedLintLimit(state) {
	return state.lintRounds >= maximumLintRounds;
}
function lintLimitDecision(state) {
	if (state.lastFindings === void 0) return {};
	return { systemMessage: findingMessage(state, state.lastFindings.reportPath) };
}
function runtimeFailureMessage(message) {
	return `alint-plugin: Stop Gate failed -- Do not attempt to fix it yourself; Tell the user to resolve the following error: ${message}`;
}
function findingMessage(state, reportPath) {
	const findings = state.lastFindings;
	if (findings === void 0) return "";
	const findingKind = findings.status === "warnings" ? "warnings" : "errors";
	return `alint-plugin: ${findings.errorCount} error(s), ${findings.warningCount} warning(s). Review the report at "${reportPath}" carefully. Act only on findings that are valid, valuable, and relevant to the current uncommitted changes. Do not make opportunistic changes merely to silence findings, such as deleting code, ignoring files, disabling rules, or changing the alint configuration. If you determine that none of the reported ${findingKind} are valid or valuable, tell the user that the alint configuration may need to be revised, but do not change it yourself.`;
}
function repeatedFindingsMessage(state, reportPath) {
	const findings = state.lastFindings;
	if (findings === void 0) return "";
	return `alint-plugin: The same ${findings.errorCount} error(s) and ${findings.warningCount} warning(s) remain unchanged from the previous automatic lint. Stop Gate is allowing this turn to finish. The report remains at "${reportPath}".`;
}
function requiredFindingsHash(envelope) {
	if (envelope.findingsHash === void 0 || envelope.findingsHash.length === 0) throw new Error("alint Stop Gate did not return a findings hash for its diagnostics.");
	return envelope.findingsHash;
}
function requiredReportPath(envelope) {
	if (envelope.reportPath === void 0 || envelope.reportPath.length === 0) throw new Error("alint Stop Gate did not return a report path for its diagnostics.");
	return envelope.reportPath;
}
function updateState(state, now, patch) {
	return {
		...state,
		...patch,
		schemaVersion: 2,
		updatedAt: now.toISOString()
	};
}
//#endregion
//#region ../../node_modules/.pnpm/tinyexec@1.2.4/node_modules/tinyexec/dist/main.mjs
const h = /^path$/i;
const g = {
	key: "PATH",
	value: ""
};
function _(e) {
	for (const t in e) {
		if (!Object.prototype.hasOwnProperty.call(e, t) || !h.test(t)) continue;
		const n = e[t];
		if (!n) return g;
		return {
			key: t,
			value: n
		};
	}
	return g;
}
function v(e, t) {
	const n = t.value.split(delimiter);
	const r = [];
	let o = e;
	let c;
	do {
		r.push(resolve(o, "node_modules", ".bin"));
		c = o;
		o = dirname(o);
	} while (o !== c);
	r.push(dirname(process.execPath));
	const l = r.concat(n).join(delimiter);
	return {
		key: t.key,
		value: l
	};
}
function y(e, t, n = true) {
	const r = {
		...process.env,
		...t
	};
	if (!n) return r;
	const i = v(e, _(r));
	r[i.key] = i.value;
	return r;
}
const b = (e) => {
	let t = e.length;
	const n = new PassThrough();
	const r = () => {
		if (--t === 0) n.end();
	};
	for (const t of e) pipeline(t, n, { end: false }).then(r).catch(r);
	return n;
};
const x = /([()\][%!^"`<>&|;, *?])/g;
const S = /^#!\s*(.+)/;
const C = /\.(?:com|exe)$/i;
const w = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;
const T = process.platform === "win32";
const E = [
	".EXE",
	".CMD",
	".BAT",
	".COM"
];
/**
* Normalizes the command and arguments to work cross-platform.
* On Windows, this basically handles things like shebangs, calling
* `node_modules/.bin` commands, and escaping meta characters.
* On other platforms, it just returns the command and arguments as-is.
*/
function D(e, t = [], n = {}) {
	if (n.shell === true || !T) return {
		command: e,
		args: t,
		options: n
	};
	let i = O(e, n);
	let a = null;
	if (i !== null) {
		const e = 150;
		const t = Buffer.alloc(e);
		let n = null;
		try {
			n = openSync(i, "r");
			readSync(n, t, 0, e, 0);
		} catch {} finally {
			if (n !== null) closeSync(n);
		}
		const o = t.toString().match(S);
		if (o !== null) {
			const e = o[1].trim();
			const t = e.indexOf(" ");
			const n = t !== -1 ? e.slice(0, t) : e;
			const i = t !== -1 ? e.slice(t + 1) : "";
			const s = basename(n);
			a = s === "env" ? i || null : s;
		}
	}
	if (a !== null && i !== null) {
		t = [i, ...t];
		e = a;
		i = O(e, n);
	}
	if (i === null || !C.test(i)) {
		const r = i !== null && w.test(i);
		e = normalize(e);
		e = e.replace(x, "^$1");
		t = t.map((e) => {
			e = e.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
			e = e.replace(/(?=(\\+?)?)\1$/, "$1$1");
			e = `"${e}"`;
			e = e.replace(x, "^$1");
			if (r) e = e.replace(x, "^$1");
			return e;
		});
		t = [
			"/d",
			"/s",
			"/c",
			`"${[e, ...t].join(" ")}"`
		];
		e = n.env?.comspec ?? "cmd.exe";
		n = {
			...n,
			windowsVerbatimArguments: true
		};
	}
	return {
		command: e,
		args: t,
		options: n
	};
}
/**
* Resolves the command to an absolute path if possible.
* Handles things like traversing PATH and adding extensions from PATHEXT
*/
function O(e, t) {
	const r = (t.cwd ?? cwd()).toString();
	const a = t.env ?? process.env;
	const o = _(a).value;
	const c = e.includes("/") || e.includes("\\") ? [""] : [r, ...o.split(delimiter)];
	const l = a.PATHEXT ? a.PATHEXT.split(delimiter) : E;
	if (e.includes(".") && l[0] !== "") l.unshift("");
	for (const t of c) {
		const n = resolve(r, t.startsWith("\"") && t.endsWith("\"") && t.length > 1 ? t.slice(1, -1) : t, e);
		for (const e of l) {
			const t = n + e;
			try {
				if (statSync(t).isFile()) return t;
			} catch {}
		}
	}
	return null;
}
var k = class extends Error {
	result;
	output;
	get exitCode() {
		if (this.result.exitCode !== null) return this.result.exitCode;
	}
	constructor(e, t) {
		super(`Process exited with non-zero status (${e.exitCode})`);
		this.result = e;
		this.output = t;
	}
};
const j = {
	timeout: void 0,
	persist: false
};
const N = { windowsHide: true };
function P(e) {
	const t = new AbortController();
	for (const n of e) {
		if (n.aborted) {
			t.abort();
			return n;
		}
		const e = () => {
			t.abort(n.reason);
		};
		n.addEventListener("abort", e, { signal: t.signal });
	}
	return t.signal;
}
async function F(e) {
	let t = "";
	try {
		for await (const n of e) t += n.toString();
	} catch {}
	return t;
}
var I = class {
	_process;
	_aborted = false;
	_options;
	_command;
	_args;
	_resolveClose;
	_processClosed;
	_thrownError;
	get process() {
		return this._process;
	}
	get pid() {
		return this._process?.pid;
	}
	get exitCode() {
		if (this._process && this._process.exitCode !== null) return this._process.exitCode;
	}
	constructor(e, t, n) {
		this._options = {
			...j,
			...n
		};
		this._command = e;
		this._args = t ?? [];
		this._processClosed = new Promise((e) => {
			this._resolveClose = e;
		});
	}
	kill(e) {
		return this._process?.kill(e) === true;
	}
	get aborted() {
		return this._aborted;
	}
	get killed() {
		return this._process?.killed === true;
	}
	pipe(e, t, n) {
		return z(e, t, {
			...n,
			stdin: this
		});
	}
	async *[Symbol.asyncIterator]() {
		const e = this._process;
		if (!e) return;
		const t = [];
		if (this._streamErr) t.push(this._streamErr);
		if (this._streamOut) t.push(this._streamOut);
		const n = b(t);
		const r = u.createInterface({ input: n });
		for await (const e of r) yield e.toString();
		await this._processClosed;
		e.removeAllListeners();
		if (this._thrownError) throw this._thrownError;
		if (this._options?.throwOnError && this.exitCode !== 0 && this.exitCode !== void 0) throw new k(this);
	}
	async _waitForOutput() {
		const e = this._process;
		if (!e) throw new Error("No process was started");
		const [t, n] = await Promise.all([this._streamOut ? F(this._streamOut) : "", this._streamErr ? F(this._streamErr) : ""]);
		await this._processClosed;
		const { stdin: r } = this._options;
		if (r && typeof r !== "string") await r;
		e.removeAllListeners();
		if (this._thrownError) throw this._thrownError;
		const i = {
			stderr: n,
			stdout: t,
			exitCode: this.exitCode
		};
		if (this._options.throwOnError && this.exitCode !== 0 && this.exitCode !== void 0) throw new k(this, i);
		return i;
	}
	then(e, t) {
		return this._waitForOutput().then(e, t);
	}
	_streamOut;
	_streamErr;
	spawn() {
		const t = cwd();
		const r = this._options;
		const i = {
			...N,
			...r.nodeOptions
		};
		const a = [];
		this._resetState();
		if (r.timeout !== void 0) a.push(AbortSignal.timeout(r.timeout));
		if (r.signal !== void 0) a.push(r.signal);
		if (r.persist === true) i.detached = true;
		if (a.length > 0) i.signal = P(a);
		i.env = y(t, i.env, r.nodePath);
		const o = D(this._command, this._args, i);
		const s = spawn(o.command, o.args, o.options);
		if (s.stderr) this._streamErr = s.stderr;
		if (s.stdout) this._streamOut = s.stdout;
		this._process = s;
		s.once("error", this._onError);
		s.once("close", this._onClose);
		if (s.stdin) {
			const { stdin: e } = r;
			if (typeof e === "string") s.stdin.end(e);
			else e?.process?.stdout?.pipe(s.stdin);
		}
	}
	_resetState() {
		this._aborted = false;
		this._processClosed = new Promise((e) => {
			this._resolveClose = e;
		});
		this._thrownError = void 0;
	}
	_onError = (e) => {
		if (e.name === "AbortError" && (!(e.cause instanceof Error) || e.cause.name !== "TimeoutError")) {
			this._aborted = true;
			return;
		}
		this._thrownError = e;
	};
	_onClose = () => {
		if (this._resolveClose) this._resolveClose();
	};
};
const R = (e, t, n) => {
	const r = new I(e, t, n);
	r.spawn();
	return r;
};
const z = R;
//#endregion
//#region src/runner.ts
const startupTimeoutMs = 6e4;
const stderrExcerptLimitBytes = 4096;
const stderrTruncationMarker = "\n... stderr truncated ...\n";
async function findGitRoot(cwd) {
	const execution = R("git", ["rev-parse", "--show-toplevel"], commandOptions(cwd, startupTimeoutMs));
	const result = await execution;
	if (execution.killed) throw new Error("Git root discovery exceeded the 1 minute startup limit.");
	if (result.exitCode !== 0) return;
	return result.stdout.trim() || void 0;
}
async function hasProjectConfig(gitRoot) {
	return (await readdir(gitRoot, { withFileTypes: true })).some((entry) => entry.isFile() && entry.name.startsWith("alint.config."));
}
async function isHeadDetached(gitRoot) {
	const execution = R("git", [
		"symbolic-ref",
		"--quiet",
		"HEAD"
	], commandOptions(gitRoot, startupTimeoutMs));
	const result = await execution;
	if (execution.killed) throw new Error("Git HEAD inspection exceeded the 1 minute startup limit.");
	if (result.exitCode === 0) return false;
	if (result.exitCode === 1) return true;
	const detail = truncateStderr(result.stderr.trim());
	throw new Error(detail.length === 0 ? `Git HEAD inspection failed with exit code ${result.exitCode ?? "unknown"} and produced no stderr output.` : `Git HEAD inspection failed with exit code ${result.exitCode ?? "unknown"}: ${detail}`);
}
async function resolveAlintStopGate(gitRoot) {
	const commands = await resolveCommands(gitRoot);
	const startupDeadline = Date.now() + startupTimeoutMs;
	for (const command of commands) {
		const config = await probeStopGateConfig(command, gitRoot, startupDeadline);
		if (config === void 0) continue;
		return {
			enabled: config.enabled,
			run: (sessionId) => executeStopGate(command, gitRoot, sessionId, config.timeoutMs),
			target: config.target
		};
	}
	throw new Error(["Could not find an alint CLI that supports `integrations stop-gate`.", "Ask the user for approval before installing or updating @alint-js/cli in this repository."].join(" "));
}
function abnormalAlintMessage(stderr) {
	const detail = truncateStderr(stderr.trim());
	return detail.length === 0 ? "alint Stop Gate exited abnormally with exit code 1 and produced no stderr output." : `alint Stop Gate exited abnormally with exit code 1: ${detail}`;
}
function addStartupAllowance(lintTimeoutMs) {
	return Math.min(lintTimeoutMs + startupTimeoutMs, Number.MAX_SAFE_INTEGER);
}
async function canAccess(path, mode) {
	try {
		await access(path, mode);
		return true;
	} catch (error) {
		if (isNodeError$1(error) && (error.code === "ENOENT" || error.code === "EACCES")) return false;
		throw error;
	}
}
function commandOptions(cwd, timeout) {
	return {
		nodeOptions: { cwd },
		nodePath: false,
		timeout
	};
}
function createLongTimeout(timeoutMs) {
	const controller = new AbortController();
	let remainingMs = timeoutMs;
	let timer;
	const schedule = () => {
		const delay = Math.min(remainingMs, 2147483647);
		timer = setTimeout(() => {
			remainingMs -= delay;
			if (remainingMs > 0) {
				schedule();
				return;
			}
			controller.abort(new DOMException("alint Stop Gate timed out.", "TimeoutError"));
		}, delay);
	};
	schedule();
	return {
		dispose: () => clearTimeout(timer),
		signal: controller.signal
	};
}
async function detectPackageManager(gitRoot) {
	const packageManager = await readPackageManagerField(gitRoot);
	if (packageManager !== void 0) return packageManager;
	for (const [lockfile, manager] of [
		["pnpm-lock.yaml", "pnpm"],
		["yarn.lock", "yarn"],
		["bun.lock", "bun"],
		["bun.lockb", "bun"],
		["package-lock.json", "npm"],
		["npm-shrinkwrap.json", "npm"]
	]) if (await pathExists(join(gitRoot, lockfile))) return manager;
}
function emptyConfigOutputError(stderr) {
	const detail = truncateStderr(stderr.trim());
	const stderrContext = detail.length === 0 ? "" : ` alint wrote to stderr: ${detail}`;
	return /* @__PURE__ */ new Error(`alint exited successfully but produced no Stop Gate configuration output. Run \`alint config integrations stop-gate show\` manually and make sure it writes the resolved configuration to stdout.${stderrContext}`);
}
async function executeStopGate(command, gitRoot, sessionId, lintTimeoutMs) {
	const timeout = createLongTimeout(addStartupAllowance(lintTimeoutMs));
	const execution = R(command.executable, [
		...command.args,
		"integrations",
		"stop-gate",
		"--session-id",
		sessionId
	], {
		nodeOptions: { cwd: gitRoot },
		nodePath: false,
		signal: timeout.signal
	});
	let result;
	try {
		result = await execution;
	} finally {
		timeout.dispose();
	}
	if (execution.aborted) throw new Error("alint did not finish within its configured lint timeout plus the 1 minute startup allowance.");
	const envelope = parseEnvelope(result.stdout);
	if (envelope === void 0) {
		if (result.exitCode === 1) throw new Error(abnormalAlintMessage(result.stderr));
		throw incompatibleAlintError();
	}
	if (!isExpectedStopGateExitCode(result.exitCode, envelope.status)) throw new Error(`alint Stop Gate returned status "${envelope.status}" with unexpected exit code ${result.exitCode ?? "unknown"}.`);
	return envelope;
}
function incompatibleAlintError() {
	return /* @__PURE__ */ new Error("The resolved alint CLI does not support the Stop Gate protocol. Update @alint-js/cli before using this plugin.");
}
async function isExecutable(path) {
	return canAccess(path, process$1.platform === "win32" ? constants.F_OK : constants.X_OK);
}
function isExpectedStopGateExitCode(exitCode, status) {
	return exitCode === (status === "runtime-error" ? 1 : 0);
}
function isNodeError$1(error) {
	return error instanceof Error && "code" in error;
}
function isStopGateStatus(value) {
	return value === "clean" || value === "errors" || value === "inactive" || value === "no-dirty-files" || value === "runtime-error" || value === "warnings";
}
function packageManagerCommand(manager) {
	if (manager === "npm") return {
		args: [
			"exec",
			"--offline",
			"--yes=false",
			"--",
			"alint"
		],
		executable: "npm",
		source: "package-manager"
	};
	if (manager === "bun") return {
		args: [
			"x",
			"--no-install",
			"alint"
		],
		executable: "bun",
		source: "package-manager"
	};
	return {
		args: ["exec", "alint"],
		executable: manager,
		source: "package-manager"
	};
}
function packageManagerTimeoutError(command) {
	const subject = command.source === "package-manager" ? `${command.executable} package-manager exec` : `${command.executable} startup`;
	return /* @__PURE__ */ new Error(`${subject} exceeded the 1 minute startup limit. Run the Stop Gate config command manually and fix the local installation before retrying.`);
}
function parseEnvelope(stdout) {
	try {
		const value = JSON.parse(stdout.trim());
		if (value.schemaVersion !== 2 || !isStopGateStatus(value.status) || typeof value.errorCount !== "number" || typeof value.warningCount !== "number" || (value.status === "errors" || value.status === "warnings") && (typeof value.findingsHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.findingsHash))) return;
		return value;
	} catch {
		return;
	}
}
function parseStopGateConfig(stdout) {
	const enabled = /^enabled: (true|false)(?: |$)/mu.exec(stdout)?.[1];
	const target = /^target: (all|dirty-files)(?: |$)/mu.exec(stdout)?.[1];
	const timeoutMs = Number(/^timeoutMs: (\S+)/mu.exec(stdout)?.[1]);
	if (enabled === void 0 || target !== "all" && target !== "dirty-files" || !Number.isInteger(timeoutMs) || timeoutMs <= 0) return;
	return {
		enabled: enabled === "true",
		target,
		timeoutMs
	};
}
async function pathExists(path) {
	return canAccess(path, constants.F_OK);
}
async function probeStopGateConfig(command, gitRoot, deadline) {
	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0) throw packageManagerTimeoutError(command);
	let execution;
	try {
		execution = R(command.executable, [
			...command.args,
			"config",
			"integrations",
			"stop-gate",
			"show"
		], commandOptions(gitRoot, remainingMs));
		const result = await execution;
		if (execution.killed) throw packageManagerTimeoutError(command);
		if (result.exitCode !== 0) {
			if (command.source === "local") throw repositoryConfigError(result);
			return;
		}
		if (result.stdout.trim().length === 0) throw emptyConfigOutputError(result.stderr);
		const config = parseStopGateConfig(result.stdout);
		if (config === void 0) throw incompatibleAlintError();
		return config;
	} catch (error) {
		if (execution?.killed) throw packageManagerTimeoutError(command);
		if (isNodeError$1(error) && error.code === "ENOENT") return;
		throw error;
	}
}
async function readPackageManagerField(gitRoot) {
	try {
		const packageJson = JSON.parse(await readFile(join(gitRoot, "package.json"), "utf8"));
		if (typeof packageJson.packageManager !== "string") return;
		const name = packageJson.packageManager.split("@", 1)[0];
		return name === "bun" || name === "npm" || name === "pnpm" || name === "yarn" ? name : void 0;
	} catch (error) {
		if (isNodeError$1(error) && error.code === "ENOENT") return;
		throw error;
	}
}
function repositoryConfigError(result) {
	const detail = truncateStderr(result.stderr.trim());
	const exitCode = result.exitCode ?? "unknown";
	const reason = detail.length === 0 ? `exit code ${exitCode} with no stderr output` : `exit code ${exitCode}: ${detail}`;
	return /* @__PURE__ */ new Error(`The repository-local alint could not read Stop Gate configuration due to ${reason}. Run \`alint config integrations stop-gate show\` manually.`);
}
async function resolveCommands(gitRoot) {
	const commands = [];
	const local = join(gitRoot, "node_modules", ".bin", process$1.platform === "win32" ? "alint.cmd" : "alint");
	if (await isExecutable(local)) commands.push({
		args: [],
		executable: local,
		source: "local"
	});
	const packageManager = await detectPackageManager(gitRoot);
	if (packageManager !== void 0) commands.push(packageManagerCommand(packageManager));
	commands.push({
		args: [],
		executable: "alint",
		source: "path"
	});
	return commands;
}
function truncateStderr(stderr) {
	const bytes = Buffer$1.from(stderr, "utf8");
	if (bytes.length <= stderrExcerptLimitBytes) return stderr;
	const markerBytes = Buffer$1.byteLength(stderrTruncationMarker);
	const excerptBytes = stderrExcerptLimitBytes - markerBytes;
	const headBytes = Math.ceil(excerptBytes / 2);
	const tailBytes = Math.floor(excerptBytes / 2);
	let headEnd = headBytes;
	let tailStart = bytes.length - tailBytes;
	while (headEnd > 0 && ((bytes[headEnd] ?? 0) & 192) === 128) headEnd -= 1;
	while (tailStart < bytes.length && ((bytes[tailStart] ?? 0) & 192) === 128) tailStart += 1;
	return `${bytes.toString("utf8", 0, headEnd)}${stderrTruncationMarker}${bytes.toString("utf8", tailStart)}`;
}
//#endregion
//#region src/state.ts
const retentionMs = 31536e6;
const stateSchemaVersion = 2;
function createStateStore(pluginDataDirectory, now = () => /* @__PURE__ */ new Date()) {
	const stopGateDirectory = join(pluginDataDirectory, "stop-gate");
	const sessionsDirectory = join(stopGateDirectory, `sessions-v${stateSchemaVersion}`);
	return {
		async load(sessionId) {
			const statePath = getStatePath(sessionsDirectory, sessionId);
			try {
				return parseState(JSON.parse(await readFile(statePath, "utf8")));
			} catch (error) {
				if (isNodeError(error) && error.code === "ENOENT") return emptyState();
				throw error;
			}
		},
		async save(sessionId, state) {
			const statePath = getStatePath(sessionsDirectory, sessionId);
			const tempPath = join(sessionsDirectory, `${sessionId}-${randomUUID()}.tmp`);
			await mkdir(sessionsDirectory, { recursive: true });
			await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
			await rename(tempPath, statePath);
			await pruneExpiredStateDirectories(stopGateDirectory, now().getTime());
		}
	};
}
function emptyState() {
	return {
		lintRounds: 0,
		runtimeFailures: 0,
		schemaVersion: stateSchemaVersion,
		updatedAt: (/* @__PURE__ */ new Date(0)).toISOString()
	};
}
function assertSafeSessionId(sessionId) {
	if (sessionId === "." || sessionId === ".." || !/^[\w.-]+$/u.test(sessionId)) throw new Error("Invalid Stop hook session id.");
}
function getStatePath(directory, sessionId) {
	assertSafeSessionId(sessionId);
	return join(directory, `${sessionId}.json`);
}
function isFindingSummary(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const finding = value;
	return Number.isInteger(finding.errorCount) && (finding.errorCount ?? -1) >= 0 && typeof finding.findingsHash === "string" && /^[a-f0-9]{64}$/u.test(finding.findingsHash) && typeof finding.reportPath === "string" && (finding.status === "errors" || finding.status === "warnings") && Number.isInteger(finding.warningCount) && (finding.warningCount ?? -1) >= 0;
}
function isNodeError(error) {
	return error instanceof Error && "code" in error;
}
function parseState(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid Stop Gate session state.");
	const state = value;
	if (state.schemaVersion !== 2 || !Number.isInteger(state.lintRounds) || (state.lintRounds ?? -1) < 0 || !Number.isInteger(state.runtimeFailures) || (state.runtimeFailures ?? -1) < 0 || typeof state.updatedAt !== "string") throw new TypeError("Invalid Stop Gate session state.");
	if (state.lastFindings !== void 0 && !isFindingSummary(state.lastFindings)) throw new TypeError("Invalid Stop Gate session state.");
	return state;
}
async function pruneExpiredStateDirectories(directory, nowMs) {
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^sessions(?:-v\d+)?$/u.test(entry.name)) continue;
		await pruneExpiredStates(join(directory, entry.name), nowMs);
	}
}
async function pruneExpiredStates(directory, nowMs) {
	const entries = await readdir(directory, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const path = join(directory, entry.name);
		if (nowMs - (await stat(path)).mtimeMs > retentionMs) await rm(path, { force: true });
	}
}
//#endregion
//#region src/stop-gate.ts
function emergencyDecision(input, error) {
	const message = runtimeFailureMessage(errorMessageFrom(error) ?? "unknown error");
	return input?.stop_hook_active ? { systemMessage: message } : {
		decision: "block",
		reason: message
	};
}
function emit(decision) {
	if (Object.keys(decision).length > 0) writeSync(process$1.stdout.fd, `${JSON.stringify(decision)}\n`);
}
function emptyEnvelope(status) {
	return {
		errorCount: 0,
		schemaVersion: 2,
		status,
		warningCount: 0
	};
}
function readHookInput() {
	const input = readFileSync(0, "utf8").trim();
	return input.length === 0 ? {} : JSON.parse(input);
}
function reportFatalFailure(context, error) {
	const detail = errorMessageFrom(error) ?? "unknown error";
	const diagnostic = writeFatalDiagnostic(context, detail);
	const saved = diagnostic.path === void 0 ? "" : ` Diagnostic saved to "${diagnostic.path}".`;
	const writeFailure = diagnostic.writeError === void 0 ? "" : ` Could not save the diagnostic: ${diagnostic.writeError}.`;
	const cleanupFailure = diagnostic.cleanupError === void 0 ? "" : ` The diagnostic was saved, but old diagnostic cleanup failed: ${diagnostic.cleanupError}.`;
	writeSync(process$1.stderr.fd, `alint-plugin: Stop Gate ${context}: ${detail}.${saved}${writeFailure}${cleanupFailure}\n`);
	process$1.exitCode = 1;
}
function requiredString(value, message) {
	if (value === void 0 || value.length === 0) throw new Error(message);
	return value;
}
let parsedInput;
try {
	parsedInput = readHookInput();
} catch (error) {
	reportFatalFailure("could not read Codex hook input", error);
}
if (parsedInput !== void 0) run(parsedInput).catch((error) => {
	try {
		emit(emergencyDecision(parsedInput, error));
	} catch (emitError) {
		reportFatalFailure("could not return its emergency decision", emitError);
	}
});
async function run(input) {
	const sessionId = requiredString(input.session_id, "Stop hook input did not include session_id.");
	const store = createStateStore(requiredString(process$1.env.CLAUDE_PLUGIN_DATA, "Codex did not provide CLAUDE_PLUGIN_DATA to the alint plugin."));
	const state = await store.load(sessionId);
	let result;
	try {
		result = await runForInput(input, sessionId, state);
	} catch (error) {
		result = { envelope: {
			...emptyEnvelope("runtime-error"),
			message: errorMessageFrom(error) ?? "unknown error"
		} };
	}
	if (result.decision !== void 0) {
		emit(result.decision);
		return;
	}
	const applied = applyResult(state, result.envelope ?? emptyEnvelope("runtime-error"));
	await store.save(sessionId, applied.state);
	emit(applied.decision);
}
async function runForInput(input, sessionId, state) {
	const gitRoot = await findGitRoot(input.cwd ?? process$1.cwd());
	if (gitRoot === void 0 || !await hasProjectConfig(gitRoot)) return { envelope: emptyEnvelope("inactive") };
	const stopGate = await resolveAlintStopGate(gitRoot);
	if (!stopGate.enabled) return { envelope: emptyEnvelope("inactive") };
	if (stopGate.target === "dirty-files" && await isHeadDetached(gitRoot)) return { decision: { systemMessage: "alint-plugin: Stop Gate skipped because Git HEAD is detached. You may need to let the user know that. Run `alint --dirty` manually if this checkout should be reviewed." } };
	if (hasReachedLintLimit(state)) return { decision: lintLimitDecision(state) };
	return { envelope: await stopGate.run(sessionId) };
}
//#endregion
export {};
