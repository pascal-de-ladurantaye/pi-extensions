/**
 * Dynamic Context — shell command injection at prompt expansion time.
 *
 * Supports the `!`command`` syntax (à la Claude Code skills) in prompt templates,
 * skill content, and direct prompts.  Each `!`command`` is executed via bash and
 * the placeholder is replaced with the command output before the LLM sees it.
 *
 * All work happens in the `context` hook:
 *   - Scan user messages for `!`…`` patterns
 *   - Execute uncached commands (keyed by message identity — timestamp + content
 *     hash — so the same command in a later message re-runs with fresh output)
 *   - Replace patterns in-place in the message copy the LLM will see
 *   - Show a diff notification for newly resolved commands
 *
 * Cache is persisted per-message via `appendEntry` so `/fork` and `/resume`
 * restore the right results for each branch.
 *
 * Commands:
 *   /dynamic-context — show the current command→output cache
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const INJECT_RE = /!`([^`]+)`/g;

export default function (pi: ExtensionAPI) {
	// messageKey (timestamp + content hash) → (command → output)
	const cache = new Map<string, Map<string, string>>();

	// keys already persisted — avoids duplicate appendEntry calls
	const persisted = new Set<string>();

	// ── helpers ──────────────────────────────────────────────

	/** Stable identity for a user message (no entry ID available in context). */
	function messageKey(msg: any): string {
		const ts: number = msg.timestamp ?? 0;
		let text = "";
		if (Array.isArray(msg.content)) {
			for (const p of msg.content) {
				if (p.type === "text") { text += p.text; break; }
			}
		} else if (typeof msg.content === "string") {
			text = msg.content;
		}
		// djb2 hash — fast, good distribution, zero deps
		let h = 5381;
		for (let i = 0; i < text.length; i++) {
			h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
		}
		return `${ts}:${h.toString(36)}`;
	}

	function findInjections(text: string): { full: string; cmd: string }[] {
		const out: { full: string; cmd: string }[] = [];
		let m: RegExpExecArray | null;
		INJECT_RE.lastIndex = 0;
		while ((m = INJECT_RE.exec(text)) !== null) {
			out.push({ full: m[0], cmd: m[1] });
		}
		return out;
	}

	async function exec(cmd: string): Promise<string> {
		try {
			const r = await pi.exec("bash", ["-c", cmd], { timeout: 30_000 });
			const out = [r.stdout, r.stderr]
				.filter((s) => s?.trim())
				.join("\n")
				.trim();
			return r.code !== 0
				? `[exit ${r.code}] ${out || "(no output)"}`
				: out || "(no output)";
		} catch (e: any) {
			return `[error: ${e.message ?? e}]`;
		}
	}

	// ── restore cache from session branch ────────────────────

	pi.on("session_start", async (_ev, ctx) => {
		cache.clear();
		persisted.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (
				entry.type === "custom" &&
				entry.customType === "dynamic-context"
			) {
				const { key, commands } = entry.data as {
					key: string;
					commands: Record<string, string>;
				};
				cache.set(key, new Map(Object.entries(commands)));
				persisted.add(key);
			}
		}
	});

	// ── single hook: detect → execute → replace → notify ────

	pi.on("context", async (event, ctx) => {
		let changed = false;
		const freshRuns: { cmd: string; output: string }[] = [];
		const dirtyKeys = new Set<string>();

		for (const msg of event.messages) {
			if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

			const key = messageKey(msg);
			let msgCache = cache.get(key);

			for (const part of msg.content) {
				if (part.type !== "text") continue;
				const injections = findInjections(part.text);
				if (injections.length === 0) continue;

				// execute commands we haven't resolved for THIS message yet
				for (const { cmd } of injections) {
					if (msgCache?.has(cmd)) continue;

					const output = await exec(cmd);
					if (!msgCache) {
						msgCache = new Map();
						cache.set(key, msgCache);
					}
					msgCache.set(cmd, output);
					freshRuns.push({ cmd, output });
					dirtyKeys.add(key);
				}

				// replace all patterns with cached output
				part.text = part.text.replace(
					INJECT_RE,
					(full: string, cmd: string) => {
						const out = msgCache?.get(cmd);
						if (out !== undefined) {
							changed = true;
							return out;
						}
						return full;
					},
				);
			}
		}

		// persist only newly-resolved or updated message caches
		for (const key of dirtyKeys) {
			const cmds = cache.get(key);
			if (!cmds) continue;
			pi.appendEntry("dynamic-context", {
				key,
				commands: Object.fromEntries(cmds),
			});
			persisted.add(key);
		}

		// diff notification for the new commands
		if (freshRuns.length > 0) {
			const diff = freshRuns.map(({ cmd, output }) => {
				const lines = output.split("\n");
				const preview =
					lines.length <= 3
						? lines.map((l) => `  + ${l}`).join("\n")
						: lines
								.slice(0, 3)
								.map((l) => `  + ${l}`)
								.join("\n") +
							`\n  … (${lines.length} lines total)`;
				return "  - !" + "`" + cmd + "`" + "\n" + preview;
			});

			ctx.ui.notify(
				`⚡ Dynamic context · ${freshRuns.length} command${freshRuns.length !== 1 ? "s" : ""} resolved\n\n${diff.join("\n\n")}`,
				"info",
			);
		}

		if (changed) return { messages: event.messages };
	});

	// ── /dynamic-context — inspect the cache ────────────────

	pi.registerCommand("dynamic-context", {
		description: "Show cached dynamic context injections",
		handler: async (_args, ctx) => {
			if (cache.size === 0) {
				ctx.ui.notify("No dynamic context cached", "info");
				return;
			}
			const lines: string[] = [];
			for (const [key, cmds] of cache) {
				for (const [cmd, out] of cmds) {
					const n = out.split("\n").length;
					lines.push(
						`  [${key}] ${cmd} → ${n} line${n !== 1 ? "s" : ""}`,
					);
				}
			}
			ctx.ui.notify(
				`Dynamic context cache:\n${lines.join("\n")}`,
				"info",
			);
		},
	});
}
