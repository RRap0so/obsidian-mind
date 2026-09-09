/**
 * Integration tests for the shared Stop/SessionEnd hook entry point.
 * Locks the silent per-turn Stop behavior, the visible true-session-end
 * handoff, stop_hook_active semantics, and the JSON output envelope.
 *
 * The envelope matters more than it looks. Session-end stdout is
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

before(() => {
	TMP_DIR = mkdtempSync(join(tmpdir(), "stop-checklist-"));
	SENTINEL = join(TMP_DIR, ".qmd-refresh-sentinel");
	writeFileSync(SENTINEL, "");
});

after(() => {
	rmTemp(TMP_DIR);
});

const runScript = (stdin: string | object | null) =>
	spawnHook(SCRIPT, stdin, { QMD_REFRESH_SENTINEL: SENTINEL });

/** Parse stdout as the hook envelope, failing loudly if it isn't JSON. */
function systemMessageOf(stdout: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		assert.fail(
			`conversation-boundary hook must write a JSON envelope to stdout — got:\n  ${stdout}`,
		);
	}
	const message = (parsed as { systemMessage?: unknown }).systemMessage;
	assert.equal(
		typeof message,
		"string",
		`expected a string systemMessage — got: ${stdout}`,
	);
	return message as string;
}

describe("stop-checklist", () => {
	test("re-entry on strict boolean true emits the empty envelope", () => {
		const { stdout, code } = runScript({ stop_hook_active: true });
		assert.equal(code, 0);
		// `{}` rather than zero bytes: stdout is JSON-or-nothing here and
		// "nothing" is only documented by omission. The object carries no
		// field, so nothing renders on any agent.
		assert.deepEqual(JSON.parse(stdout), {});
	});

	test("re-entry writes its envelope before exiting", () => {
		// Regression guard for a platform-specific truncation: stdout is a
		// pipe, pipe writes are async on Windows, and this path writes and
		// then immediately calls process.exit(). A non-sync write here
		// arrives empty on Windows and passes everywhere else.
		const { stdout } = runScript({ stop_hook_active: true });
		assert.equal(stdout, "{}");
	});

	test("normal per-turn Stop emits the empty envelope", () => {
		const { stdout, code } = runScript({
			hook_event_name: "Stop",
			stop_hook_active: false,
		});
		assert.equal(code, 0);
		assert.deepEqual(JSON.parse(stdout), {});
	});

	test("unchanged hygiene is silent on Stops and reported at SessionEnd", () => {
		const vault = join(TMP_DIR, "drifted-vault");
		mkdirSync(join(vault, "work/active"), { recursive: true });
		writeFileSync(
			join(vault, "work/active/Done.md"),
			"---\nstatus: completed\n---\n# Done\n",
		);
		const payload = {
			session_id: "same-session",
			hook_event_name: "Stop",
			stop_hook_active: false,
		};

		const first = spawnHook(SCRIPT, payload, {
			CLAUDE_PROJECT_DIR: vault,
			QMD_REFRESH_SENTINEL: SENTINEL,
		});
		const second = spawnHook(SCRIPT, payload, {
			CLAUDE_PROJECT_DIR: vault,
			QMD_REFRESH_SENTINEL: SENTINEL,
		});
		const sessionEnd = spawnHook(
			SCRIPT,
			{ session_id: "same-session", hook_event_name: "SessionEnd" },
			{
				CLAUDE_PROJECT_DIR: vault,
				QMD_REFRESH_SENTINEL: SENTINEL,
			},
		);

		assert.deepEqual(JSON.parse(first.stdout), {});
		assert.deepEqual(JSON.parse(second.stdout), {});
		assert.match(systemMessageOf(sessionEnd.stdout), /work\/active\/Done\.md/);
	});

	test("string stop_hook_active still follows the normal silent Stop path", () => {
		const { stdout } = runScript({
			hook_event_name: "Stop",
			stop_hook_active: "true",
		});
		assert.deepEqual(JSON.parse(stdout), {});
	});

	test("SessionEnd emits the actionable checklist", () => {
		const { stdout, code } = runScript({ hook_event_name: "SessionEnd" });
		assert.equal(code, 0);
		const message = systemMessageOf(stdout);
		assert.match(message, /Session end checklist:/);
		assert.match(message, /Archive completed projects/);
		assert.match(message, /ask the agent to run om-tidy/i);
	});

	test("malformed input emits a valid SessionEnd-safe default", () => {
		const { stdout, code } = runScript("garbage{{");
		assert.equal(code, 0);
		assert.match(systemMessageOf(stdout), /Session end checklist:/);
	});

	test("empty stdin emits a valid SessionEnd-safe default", () => {
		const { stdout, code } = runScript(null);
		assert.equal(code, 0);
		assert.match(systemMessageOf(stdout), /Session end checklist:/);
	});

	test("does not terminate the message with a stray newline", () => {
		// systemMessage is rendered by the agent's UI, not written to a
		// stream — a trailing newline is padding in all three.
		const message = systemMessageOf(runScript({}).stdout);
		assert.equal(message, message.trimEnd());
	});

	// One script serves three agents whose SessionEnd payloads differ in shape.
	// Payloads mirror each vendor's documented schema.
	const AGENT_PAYLOADS: ReadonlyArray<{
		readonly label: string;
		readonly payload: Record<string, unknown>;
	}> = [
		{
			label: "Claude Code SessionEnd",
			payload: {
				session_id: "s1",
				transcript_path: "/tmp/t.json",
				cwd: ".",
				hook_event_name: "SessionEnd",
				reason: "other",
			},
		},
		{
			label: "Codex SessionEnd",
			payload: {
				session_id: "s1",
				transcript_path: "/tmp/t.json",
				cwd: ".",
				hook_event_name: "SessionEnd",
				model: "gpt-5.6-sol",
				reason: "other",
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
			const { stdout, code } = runScript(payload);
			assert.equal(code, 0);
			const message = systemMessageOf(stdout);
			assert.match(message, /Session end checklist:/);
			rendered.add(message);
		});
	}

	test("SessionEnd output does not vary by calling agent", () => {
		assert.equal(
			rendered.size,
			1,
			`every agent must get byte-identical output — got ${rendered.size} variants`,
		);
	});
});
