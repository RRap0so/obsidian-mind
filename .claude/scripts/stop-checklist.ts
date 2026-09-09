#!/usr/bin/env node
/**
 * Conversation-boundary hook — keep per-turn Stop lightweight and emit the
 * wrap-up checklist only at true SessionEnd.
 *
 * Stop fires whenever Claude or Codex finishes a response, not when the
 * conversation ends. On that event this script emits an empty JSON envelope
 * and only kicks the debounced QMD refresh. SessionEnd is the user-facing
 * boundary: it prints the checklist and the current vault-hygiene findings.
 *
 * Output is JSON on every agent, never plain text. Codex rejects plain Stop
 * stdout, Gemini's SessionEnd contract requires a final JSON object, and
 * Claude Code otherwise files non-exempt stdout in the debug log. Stop gets
 * the empty envelope; SessionEnd gets the one user-facing field all three
 * agents share, `systemMessage`. The documented event name is the only
 * branch — no agent sniffing and no agent-specific argument.
 */

import { readFileSync } from "node:fs";
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

const DEBOUNCE_MS = 30_000;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// See qmd-refresh.ts for the rationale behind the env override — it
// keeps parallel test workers from racing on the shared repo sentinel.
const SENTINEL_PATH =
	process.env["QMD_REFRESH_SENTINEL"] ??
	join(SCRIPT_DIR, ".qmd-refresh-sentinel");
const WORKER_PATH = resolvePath(SCRIPT_DIR, "qmd-refresh-run.ts");

type HookInput = {
	readonly hook_event_name?: unknown;
	readonly stop_hook_active?: unknown;
};

const input = await readStdinJson<HookInput>();
// Re-entry by a secondary agent: say nothing and spawn no second refresh,
// but still emit the empty envelope rather than zero bytes — see
// writeSilentHookOutput for why "sometimes silent, sometimes JSON" is the
// weaker contract.
if (input?.stop_hook_active === true) {
	writeSilentHookOutput();
	process.exit(0);
}

// Stop is a per-turn lifecycle event on Claude and Codex. Reporting the same
// unchanged drift here trains users to ignore the warning, and systemMessage
// cannot make the agent act on it. Keep the refresh, but reserve the visible
// handoff for true SessionEnd.
if (input?.hook_event_name === "Stop") {
	writeSilentHookOutput();
	triggerDebouncedRefresh({
		sentinelPath: SENTINEL_PATH,
		workerPath: WORKER_PATH,
		debounceMs: DEBOUNCE_MS,
		logPrefix: "stop-checklist",
	});
	process.exit(0);
}

const checklist = [
	"Session end checklist:",
	"- Archive completed projects? (work/active/ -> work/archive/YYYY/)",
	"- Update indexes? (Index.md, Memories.md, People & Context, Brag Doc)",
	"- New notes linked? (orphans are bugs)",
	"- Ask the agent to run om-vault-audit if many notes were created/modified",
	"- To act on any drift, start or resume a live session and ask the agent to run om-tidy",
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

writeSystemMessage(message);

triggerDebouncedRefresh({
	sentinelPath: SENTINEL_PATH,
	workerPath: WORKER_PATH,
	debounceMs: DEBOUNCE_MS,
	logPrefix: "stop-checklist",
});
