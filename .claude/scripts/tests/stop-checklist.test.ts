/**
 * Integration tests for the shared Stop/SessionEnd hook entry point.
 * Locks the once-per-session Stop report, the always-on SessionEnd report,
 * stop_hook_active semantics, and the JSON output envelope.
 *
 * Why Stop dedupes instead of moving to SessionEnd (#252): Stop fires after
 * every response on Claude Code and Codex, so an unconditional report repeats
 * unchanged drift on every turn. SessionEnd cannot carry it there instead —
 * Claude Code discards a SessionEnd hook's `systemMessage`, and Codex does
 * not list SessionEnd among the events whose `systemMessage` it surfaces.
 * So Stop reports once per session and again only when the report changes;
 * SessionEnd (Gemini's wiring) reports every time.
 *
 * The envelope matters more than it looks. Session-boundary stdout is
 * JSON-or-nothing on all three agents, and each one fails differently when
 * it isn't: Codex reports a hook failure, Gemini ignores the output, and
 * Claude Code files it in the debug log — silently, which is why plain text
 * survived here so long. These tests parse stdout rather than regex-matching
 * it, so a regression back to plain text fails instead of passing on a
 * substring that appears inside the JSON either way.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { runScript as spawnHook, rmTemp } from "./_helpers.ts";

const SCRIPT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../stop-checklist.ts",
);

// Route the debounce sentinel through a per-file tmp path. Every run of this
// hook calls triggerDebouncedRefresh, and without an override that lands on
// the repo's own .claude/scripts/.qmd-refresh-sentinel — shared with
// qmd-refresh.integration.test.ts, which already isolates itself and names
// this file as the reason it has to.
//
// The sentinel is created *pre-dated to now* rather than left absent,
// because "null sentinel → not debounced" is the documented rule: an empty
// tmp dir would make every one of these spawns fire a real detached QMD
// refresh at the working tree, which is both a side effect these tests
// don't want and enough load to time out unrelated suites. A fresh mtime
// puts each run inside the debounce window, so the trigger is exercised and
// then correctly declines to spawn.
let TMP_DIR = "";
let SENTINEL = "";
let stateCounter = 0;

before(() => {
	TMP_DIR = mkdtempSync(join(tmpdir(), "stop-checklist-"));
	SENTINEL = join(TMP_DIR, ".qmd-refresh-sentinel");
	writeFileSync(SENTINEL, "");
});

after(() => {
	rmTemp(TMP_DIR);
});

/** A fresh, isolated dedupe-state path, so no test sees another's history. */
function freshState(): string {
	stateCounter += 1;
	return join(TMP_DIR, `checklist-state-${stateCounter}.json`);
}

/**
 * Run the hook with an isolated sentinel and dedupe state. Pass the same
 * `state` path to several calls to simulate one machine across turns.
 */
function run(
	stdin: string | object | null,
	opts: { readonly state?: string; readonly vault?: string } = {},
) {
	return spawnHook(SCRIPT, stdin, {
		QMD_REFRESH_SENTINEL: SENTINEL,
		STOP_CHECKLIST_STATE: opts.state ?? freshState(),
		...(opts.vault ? { CLAUDE_PROJECT_DIR: opts.vault } : {}),
	});
}

/** Parse stdout as the hook envelope, failing loudly if it isn't JSON. */
function envelopeOf(stdout: string): Record<string, unknown> {
	try {
		return JSON.parse(stdout) as Record<string, unknown>;
	} catch {
		return assert.fail(
			`stop-checklist must write a JSON envelope to stdout — got:\n  ${stdout}`,
		);
	}
}

/** The envelope's systemMessage, failing loudly if absent. */
function systemMessageOf(stdout: string): string {
	const message = envelopeOf(stdout)["systemMessage"];
	assert.equal(
		typeof message,
		"string",
		`expected a string systemMessage — got: ${stdout}`,
	);
	return message as string;
}

/** A vault with one completed note left in work/active/ (a hygiene finding). */
function driftedVault(name: string): string {
	const vault = join(TMP_DIR, name);
	mkdirSync(join(vault, "work/active"), { recursive: true });
	writeFileSync(
		join(vault, "work/active/Done.md"),
		"---\nstatus: completed\n---\n# Done\n",
	);
	return vault;
}

const stop = (session_id?: string) => ({
	...(session_id === undefined ? {} : { session_id }),
	hook_event_name: "Stop",
	stop_hook_active: false,
});

describe("stop-checklist", () => {
	test("re-entry on strict boolean true emits the empty envelope", () => {
		const { stdout, code } = run({ stop_hook_active: true });
		assert.equal(code, 0);
		// `{}` rather than zero bytes: stdout is JSON-or-nothing here and
		// "nothing" is only documented by omission. The object carries no
		// field, so nothing renders on any agent.
		assert.deepEqual(envelopeOf(stdout), {});
	});

	test("re-entry writes its envelope before exiting", () => {
		// Regression guard for a platform-specific truncation: stdout is a
		// pipe, pipe writes are async on Windows, and this path writes and
		// then immediately calls process.exit(). A non-sync write here
		// arrives empty on Windows and passes everywhere else.
		const { stdout } = run({ stop_hook_active: true });
		assert.equal(stdout, "{}");
	});

	test("the first Stop of a session reports the checklist and findings", () => {
		const vault = driftedVault("first-stop");
		const message = systemMessageOf(run(stop("s-first"), { vault }).stdout);
		assert.match(message, /Session end checklist:/);
		assert.match(message, /work\/active\/Done\.md/);
	});

	test("a later Stop with an unchanged report is silent (#252)", () => {
		const vault = driftedVault("unchanged");
		const state = freshState();
		const first = run(stop("s-same"), { vault, state });
		const second = run(stop("s-same"), { vault, state });
		const third = run(stop("s-same"), { vault, state });
		assert.match(systemMessageOf(first.stdout), /work\/active\/Done\.md/);
		assert.deepEqual(envelopeOf(second.stdout), {});
		assert.deepEqual(envelopeOf(third.stdout), {});
	});

	test("a Stop whose findings changed reports again", () => {
		const vault = driftedVault("changed");
		const state = freshState();
		run(stop("s-change"), { vault, state });
		writeFileSync(
			join(vault, "work/active/Also Done.md"),
			"---\nstatus: completed\n---\n# Also done\n",
		);
		const message = systemMessageOf(run(stop("s-change"), { vault, state }).stdout);
		assert.match(message, /work\/active\/Also Done\.md/);
	});

	test("a new session reports again even when nothing changed", () => {
		const vault = driftedVault("new-session");
		const state = freshState();
		run(stop("s-one"), { vault, state });
		const other = run(stop("s-two"), { vault, state });
		assert.match(systemMessageOf(other.stdout), /work\/active\/Done\.md/);
	});

	test("a clean vault still gets the checklist once, then silence", () => {
		const vault = join(TMP_DIR, "clean-vault");
		mkdirSync(vault, { recursive: true });
		const state = freshState();
		const first = run(stop("s-clean"), { vault, state });
		const second = run(stop("s-clean"), { vault, state });
		assert.match(systemMessageOf(first.stdout), /Session end checklist:/);
		assert.doesNotMatch(systemMessageOf(first.stdout), /Vault Hygiene/);
		assert.deepEqual(envelopeOf(second.stdout), {});
	});

	test("a Stop without a session_id fails open and reports every time", () => {
		// Same rule as the classifier's hint dedupe (#107): no key to
		// remember by means today's behaviour, never silence.
		const state = freshState();
		const first = run(stop(), { state });
		const second = run(stop(), { state });
		assert.match(systemMessageOf(first.stdout), /Session end checklist:/);
		assert.match(systemMessageOf(second.stdout), /Session end checklist:/);
	});

	test("an unreadable dedupe state fails open", () => {
		const state = freshState();
		writeFileSync(state, "not json{{");
		const { stdout } = run(stop("s-corrupt"), { state });
		assert.match(systemMessageOf(stdout), /Session end checklist:/);
	});

	test("string stop_hook_active is not re-entry", () => {
		const { stdout } = run({ ...stop("s-string"), stop_hook_active: "true" });
		assert.match(systemMessageOf(stdout), /Session end checklist:/);
	});

	test("SessionEnd reports every time — it is the last chance, not a turn", () => {
		const vault = driftedVault("session-end");
		const state = freshState();
		const payload = { session_id: "s-end", hook_event_name: "SessionEnd" };
		const first = run(payload, { vault, state });
		const second = run(payload, { vault, state });
		assert.match(systemMessageOf(first.stdout), /work\/active\/Done\.md/);
		assert.match(systemMessageOf(second.stdout), /work\/active\/Done\.md/);
	});

	test("SessionEnd after a deduped Stop still reports", () => {
		const vault = driftedVault("stop-then-end");
		const state = freshState();
		run(stop("s-mixed"), { vault, state });
		const end = run({ session_id: "s-mixed", hook_event_name: "SessionEnd" }, { vault, state });
		assert.match(systemMessageOf(end.stdout), /work\/active\/Done\.md/);
	});

	test("the checklist hands drift to om-tidy", () => {
		const message = systemMessageOf(run(stop("s-handoff")).stdout);
		assert.match(message, /ask the agent to run om-tidy/i);
	});

	test("malformed input emits a valid default", () => {
		const { stdout, code } = run("garbage{{");
		assert.equal(code, 0);
		assert.match(systemMessageOf(stdout), /Session end checklist:/);
	});

	test("empty stdin emits a valid default", () => {
		const { stdout, code } = run(null);
		assert.equal(code, 0);
		assert.match(systemMessageOf(stdout), /Session end checklist:/);
	});

	test("does not terminate the message with a stray newline", () => {
		// systemMessage is rendered by the agent's UI, not written to a
		// stream — a trailing newline is padding in all three.
		const message = systemMessageOf(run({}).stdout);
		assert.equal(message, message.trimEnd());
	});

	// One script serves three agents whose payloads differ in shape: Claude
	// Code and Codex call it on Stop, Gemini on SessionEnd. Payloads mirror
	// each vendor's documented schema. Each runs against fresh state, so the
	// first report of each is the one compared.
	const AGENT_PAYLOADS: ReadonlyArray<{
		readonly label: string;
		readonly payload: Record<string, unknown>;
	}> = [
		{
			label: "Claude Code Stop",
			payload: {
				session_id: "s1",
				transcript_path: "/tmp/t.json",
				cwd: ".",
				permission_mode: "default",
				hook_event_name: "Stop",
				last_assistant_message: "done",
				stop_hook_active: false,
			},
		},
		{
			label: "Codex Stop",
			payload: {
				session_id: "s1",
				transcript_path: "/tmp/t.json",
				cwd: ".",
				hook_event_name: "Stop",
				model: "gpt-5.6-sol",
				permission_mode: "default",
				stop_hook_active: false,
			},
		},
		{
			label: "Gemini SessionEnd",
			payload: {
				session_id: "s1",
				transcript_path: "/tmp/t.json",
				cwd: ".",
				hook_event_name: "SessionEnd",
				timestamp: "2026-08-03T12:00:00Z",
				reason: "exit",
			},
		},
	];

	const rendered = new Set<string>();
	for (const { label, payload } of AGENT_PAYLOADS) {
		test(`${label} receives the same JSON envelope`, () => {
			const { stdout, code } = run(payload);
			assert.equal(code, 0);
			const message = systemMessageOf(stdout);
			assert.match(message, /Session end checklist:/);
			rendered.add(message);
		});
	}

	test("output does not vary by calling agent", () => {
		assert.equal(
			rendered.size,
			1,
			`every agent must get byte-identical output — got ${rendered.size} variants`,
		);
	});
});
