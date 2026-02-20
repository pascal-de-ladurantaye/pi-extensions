/**
 * Snapshot — Filesystem checkpoint extension for pi
 *
 * Takes shadow-git snapshots at session start and after each agent run.
 * Snapshot entries are appended to the session tree, landing between the
 * last tool result and the next user message. On /fork (always from a
 * user message), walks one hop back to find the snapshot entry.
 *
 * Timing:
 *   session_start / session_switch / session_fork → baseline snapshot
 *   agent_end → post-agent snapshot (latency hidden while user reads results)
 *
 * No external state files. Everything lives in the session tree via
 * appendEntry, so it survives fork, resume, and reload automatically.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import { track, diffSummary, restore, cleanup, setConfigDir, type FileStat } from "./lib";

export default function (pi: ExtensionAPI) {
	/** Take a snapshot and append it to the session tree. */
	async function snapshot(ctx: ExtensionContext) {
		try {
			const hash = await track(ctx.cwd);
			if (hash) pi.appendEntry("snapshot", { hash });
		} catch {}
	}

	// ── Baseline snapshots ───────────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		setConfigDir(path.resolve(ctx.sessionManager.getSessionDir(), ".."));
		await snapshot(ctx);
		void cleanup(ctx.cwd);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await snapshot(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		await snapshot(ctx);
	});

	// ── Post-agent snapshots ─────────────────────────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		await snapshot(ctx);
	});

	// ── Restore on fork ──────────────────────────────────────────────────────

	pi.on("session_before_fork", async (event, ctx) => {
		if (!ctx.hasUI) return;

		// Walk back from fork entry to find nearest snapshot
		let current: string | null = event.entryId;
		let hash: string | undefined;

		while (current) {
			const entry = ctx.sessionManager.getEntry(current);
			if (!entry) break;
			if (entry.type === "custom" && entry.customType === "snapshot") {
				hash = (entry.data as { hash: string })?.hash;
				break;
			}
			current = entry.parentId;
		}

		if (!hash) return;

		let stats: FileStat[];
		try {
			stats = await diffSummary(ctx.cwd, hash);
		} catch {
			return;
		}

		if (stats.length === 0) return;

		const ok = await ctx.ui.confirm("Restore files?", formatSummary(stats));
		if (!ok) return;

		const success = await restore(ctx.cwd, hash);
		if (success) {
			ctx.ui.notify(`Restored ${stats.length} file(s) to fork point`, "info");
		} else {
			ctx.ui.notify("Restore failed — snapshot may have expired", "warning");
		}
	});
}

// ── Formatting ───────────────────────────────────────────────────────────────

const MAX_FILES = 20;
const STATUS_CHAR: Record<string, string> = { added: "A", deleted: "D", modified: "M" };

function formatSummary(stats: FileStat[]): string {
	const totalAdd = stats.reduce((s, f) => s + f.additions, 0);
	const totalDel = stats.reduce((s, f) => s + f.deletions, 0);

	const totals = [
		totalAdd > 0 ? `+${totalAdd}` : "",
		totalDel > 0 ? `-${totalDel}` : "",
	].filter(Boolean).join(" ");

	const lines: string[] = [];
	lines.push(`${stats.length} file(s) changed${totals ? ` (${totals})` : ""}:`);
	lines.push("");

	const shown = stats.slice(0, MAX_FILES);

	for (const f of shown) {
		const s = STATUS_CHAR[f.status] ?? "M";
		const counts = f.binary
			? "(binary)"
			: formatCounts(f.additions, f.deletions);
		lines.push(`  ${s}  ${f.file}  ${counts}`);
	}

	if (stats.length > MAX_FILES) {
		lines.push(`  … and ${stats.length - MAX_FILES} more`);
	}

	return lines.join("\n");
}

function formatCounts(additions: number, deletions: number): string {
	const parts: string[] = [];
	if (additions > 0) parts.push(`+${additions}`);
	if (deletions > 0) parts.push(`-${deletions}`);
	return parts.join(" ");
}
