#!/usr/bin/env node
/**
 * Conversation-boundary hook — the wrap-up checklist plus concrete
 * vault-hygiene findings, and a debounced QMD refresh so the next session
 * opens against a current index.
 *
 * Where it runs is decided by where its message can be seen (#252):
 *
 *  - Claude Code and Codex call it on Stop, which fires after EVERY
 *    response, not at the end of the session. An unconditional report there
 *    repeats unchanged drift on every turn, and a warning that never changes
 *    is one users learn to ignore (#155). So on Stop the report is shown
 *    once per session and again only when its text changes; otherwise the
 *    hook emits the empty envelope and only refreshes QMD.
 *  - Gemini calls it on SessionEnd, whose systemMessage it displays during
 *    shutdown. That is a last chance rather than a turn, so it always reports.
 *
 * Claude Code and Codex are deliberately NOT wired to SessionEnd: Claude Code
 * discards a SessionEnd hook's systemMessage, and Codex documents SessionEnd
 * as advisory and does not surface its systemMessage. Moving the report
 * there would turn "every turn" into "never".
 *
 * Output is JSON on every agent, never plain text. Codex rejects plain Stop
 * stdout, Gemini's SessionEnd contract requires a final JSON object, and
 * Claude Code otherwise files non-exempt stdout in the debug log. The report
 * uses the one user-facing field all three agents share, `systemMessage`.
 * The documented event name is the only branch — no agent sniffing and no
 * agent-specific argument.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
	readStdinJson,
	writeSilentHookOutput,
	writeSystemMessage,
} from "./lib/hook-io.ts";
import { triggerDebouncedRefresh } from "./lib/qmd-refresh.ts";
import {
	formatActiveHygiene,
	parseMemoryRoot,
	parseOpenLoopConfig,
	scanActiveHygiene,
} from "./lib/active-hygiene.ts";
import { parseInfraRootFilenames } from "./lib/session-start.ts";
import { parseHintState, prune, record, unseen } from "./lib/hint-state.ts";

const DEBOUNCE_MS = 30_000;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// See qmd-refresh.ts for the rationale behind the env override — it
// keeps parallel test workers from racing on the shared repo sentinel.
const SENTINEL_PATH =
	process.env["QMD_REFRESH_SENTINEL"] ??
	join(SCRIPT_DIR, ".qmd-refresh-sentinel");
const WORKER_PATH = resolvePath(SCRIPT_DIR, "qmd-refresh-run.ts");
// Which reports each session has already been shown, in the same
// self-pruning, fail-open shape as the classifier's hint dedupe (#107).
// STOP_CHECKLIST_STATE routes it to a tmp path for tests.
const STATE_PATH =
	process.env["STOP_CHECKLIST_STATE"] ??
	join(SCRIPT_DIR, ".checklist-state.json");

type HookInput = {
	readonly hook_event_name?: unknown;
	readonly session_id?: unknown;
	readonly stop_hook_active?: unknown;
};

const refresh = (): void =>
	triggerDebouncedRefresh({
		sentinelPath: SENTINEL_PATH,
		workerPath: WORKER_PATH,
		debounceMs: DEBOUNCE_MS,
		logPrefix: "stop-checklist",
	});

const input = await readStdinJson<HookInput>();
// Re-entry by a secondary agent: say nothing and spawn no second refresh,
// but still emit the empty envelope rather than zero bytes — see
// writeSilentHookOutput for why "sometimes silent, sometimes JSON" is the
// weaker contract.
if (input?.stop_hook_active === true) {
	writeSilentHookOutput();
	process.exit(0);
}

const checklist = [
	"Session end checklist:",
	"- Archive completed projects? (work/active/ -> work/archive/YYYY/)",
	"- Update indexes? (Index.md, Memories.md, People & Context, Brag Doc)",
	"- New notes linked? (orphans are bugs)",
	"- Ask the agent to run om-vault-audit if many notes were created/modified",
	"- To act on any drift, ask the agent to run om-tidy (in a new session if this one has ended)",
].join("\n");

// Concrete drift findings beat a generic checklist (#98/#103/#106): the
// same scan SessionStart runs, so the session closes against the same
// facts it opened with. Silent when clean.
const vaultRoot =
	process.env["CLAUDE_PROJECT_DIR"] ||
	process.env["CODEX_PROJECT_DIR"] ||
	process.env["GEMINI_PROJECT_DIR"] ||
	resolvePath(SCRIPT_DIR, "..", "..");
let manifestJson: string | null = null;
try {
	manifestJson = readFileSync(join(vaultRoot, "vault-manifest.json"), {
		encoding: "utf-8",
	});
} catch {
	/* missing manifest → default open-loop config */
}
const hygieneLines = formatActiveHygiene(
	scanActiveHygiene(
		vaultRoot,
		Date.now(),
		parseOpenLoopConfig(manifestJson),
		parseInfraRootFilenames(manifestJson),
		parseMemoryRoot(manifestJson),
	),
);

// No trailing newline: this is a message rendered by the agent's UI, not a
// line written to a stream.
const message =
	checklist +
	(hygieneLines.length > 0
		? "\n\nVault Hygiene (drift detected):\n" + hygieneLines.join("\n")
		: "");

/**
 * Whether this Stop should show `report`: true the first time a session sees
 * this exact text, false for a repeat. Keyed by a hash of the text, so any
 * change in the findings is a new report and shows again. Fails OPEN — a
 * missing session_id or an unreadable state file means show, never silence.
 */
function firstTimeThisSession(sessionId: unknown, report: string): boolean {
	if (typeof sessionId !== "string" || !sessionId) return true;
	const key = "checklist:" + createHash("sha256").update(report).digest("hex").slice(0, 16);
	let state = parseHintState(null);
	try {
		state = parseHintState(readFileSync(STATE_PATH, { encoding: "utf-8" }));
	} catch {
		/* missing/unreadable state → empty (fail open) */
	}
	if (unseen(state, sessionId, [key]).length === 0) return false;
	try {
		const now = new Date();
		writeFileSync(
			STATE_PATH,
			JSON.stringify(prune(record(state, sessionId, [key], now.toISOString()), now.getTime())),
		);
	} catch {
		/* best-effort — a failed state write must never suppress the report */
	}
	return true;
}

// SessionEnd (and any input without a recognisable event, the safe default)
// always reports. Stop reports once per session per distinct report.
const isStop = input?.hook_event_name === "Stop";
if (!isStop || firstTimeThisSession(input?.session_id, message)) {
	writeSystemMessage(message);
} else {
	writeSilentHookOutput();
}

refresh();
