/**
 * The project directory the calling agent gave a hook or script.
 *
 * Each agent names the project directory in its own variable: Claude Code
 * sets CLAUDE_PROJECT_DIR; the Codex and Gemini configs pass
 * CODEX_PROJECT_DIR and GEMINI_PROJECT_DIR. The first non-empty one wins.
 * An empty value counts as unset (`||`, not `??`): an empty string is never
 * a usable root, and treating it as one resolved paths against "".
 *
 * The fallback is the caller's, because callers differ for a reason: most
 * fall back to the working directory, while a hook that can fire from a
 * drifted shell cwd falls back to its own location (qmd-refresh.ts's
 * resolveVaultRoot). Not to be confused with that function, which ignores
 * these variables on purpose, or with mcp-context.ts's, which reads
 * OM_VAULT_PATH for the MCP server.
 */

const PROJECT_DIR_VARS = [
	"CLAUDE_PROJECT_DIR",
	"CODEX_PROJECT_DIR",
	"GEMINI_PROJECT_DIR",
] as const;

export function resolveProjectDir(
	fallback: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	for (const name of PROJECT_DIR_VARS) {
		const value = env[name];
		if (value) return value;
	}
	return fallback;
}
