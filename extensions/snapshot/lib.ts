/**
 * Shadow Git Snapshot Library
 *
 * Maintains a separate git repository (the "shadow repo") that tracks the
 * project's working tree without touching the project's own .git history.
 *
 * Uses git plumbing commands (write-tree, read-tree, checkout-index) to create
 * lightweight tree-object snapshots — no commits, no history graph. Git's
 * object store gives us content-addressable snapshots with built-in diffing.
 *
 * Shadow repos live in ~/.pi/snapshot/<project-hash>/ and share nothing with
 * the project's git. The project doesn't even need to be a git repo.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as crypto from "node:crypto";

const execFile = promisify(execFileCb);

// ── Git execution ────────────────────────────────────────────────────────────

interface GitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function git(
	args: string[],
	opts?: { cwd?: string; env?: Record<string, string> },
): Promise<GitResult> {
	try {
		const { stdout, stderr } = await execFile("git", args, {
			cwd: opts?.cwd,
			env: opts?.env ? { ...process.env, ...opts.env } : undefined,
			maxBuffer: 50 * 1024 * 1024,
		});
		return { stdout, stderr, exitCode: 0 };
	} catch (err: any) {
		return {
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
			exitCode: typeof err.code === "number" ? err.code : 1,
		};
	}
}

// ── Path helpers ─────────────────────────────────────────────────────────────
function projectHash(cwd: string): string {
	return crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

let _configDir: string | undefined;

/** Set the config root (derived from sessionManager.getSessionDir() in index.ts). */
export function setConfigDir(dir: string) {
	_configDir = dir;
}
export function gitDir(cwd: string): string {
	const base = _configDir ?? path.join(os.homedir(), ".pi");
	return path.join(base, "data", "snapshot", projectHash(cwd));
}

// ── Shadow git operations ────────────────────────────────────────────────────

/**
 * Initialize the shadow git repo if it doesn't exist.
 * Returns the git dir path.
 */
export async function init(cwd: string): Promise<string> {
	const dir = gitDir(cwd);

	// mkdir returns the first created directory, or undefined if it existed.
	// Only initialize when the directory is freshly created.
	const created = await fs.mkdir(dir, { recursive: true }).catch(() => undefined);

	if (created !== undefined) {
		await git(["init"], {
			env: { GIT_DIR: dir, GIT_WORK_TREE: cwd },
		});
		await git(["--git-dir", dir, "config", "core.autocrlf", "false"]);
	}

	return dir;
}

/**
 * Copy the project's git info/exclude to the shadow repo so that
 * machine-local ignores (beyond .gitignore) are respected.
 */
async function syncExcludes(cwd: string, dir: string): Promise<void> {
	const target = path.join(dir, "info", "exclude");
	await fs.mkdir(path.join(dir, "info"), { recursive: true });

	const result = await git(
		["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
		{ cwd },
	);

	if (result.exitCode !== 0 || !result.stdout.trim()) {
		await fs.writeFile(target, "");
		return;
	}

	const projectExclude = result.stdout.trim();
	try {
		const text = await fs.readFile(projectExclude, "utf-8");
		await fs.writeFile(target, text);
	} catch {
		await fs.writeFile(target, "");
	}
}

/** Stage all work-tree files into the shadow repo's index. */
async function addAll(cwd: string, dir: string): Promise<void> {
	await syncExcludes(cwd, dir);
	await git(["--git-dir", dir, "--work-tree", cwd, "add", "."], { cwd });
}

/**
 * Snapshot the current filesystem state.
 *
 * Stages all files and writes a tree object. Returns the tree hash,
 * or undefined on failure. No commits are created — just a lightweight
 * content-addressable tree in the object store.
 */
export async function track(cwd: string): Promise<string | undefined> {
	const dir = await init(cwd);
	await addAll(cwd, dir);

	const result = await git(
		["--git-dir", dir, "--work-tree", cwd, "write-tree"],
		{ cwd },
	);

	if (result.exitCode !== 0) return undefined;
	const hash = result.stdout.trim();
	return hash || undefined;
}

/**
 * Per-file diff statistics between a snapshot and the current state.
 */
export interface FileStat {
	file: string;
	additions: number;
	deletions: number;
	status: "added" | "deleted" | "modified";
	binary: boolean;
}

/**
 * Get per-file diff stats between a snapshot and the current state.
 * Returns file paths, addition/deletion counts, and status.
 */
export async function diffSummary(
	cwd: string,
	hash: string,
): Promise<FileStat[]> {
	const dir = await init(cwd);
	await addAll(cwd, dir);
	const diffArgs = [
		"-c", "core.autocrlf=false",
		"-c", "core.quotepath=false",
		"--git-dir", dir,
		"--work-tree", cwd,
		"diff", "--no-ext-diff", "--no-renames",
	];

	// File statuses (A/D/M)
	const statusResult = await git(
		[...diffArgs, "--name-status", hash, "--", "."],
		{ cwd },
	);

	const statuses = new Map<string, "added" | "deleted" | "modified">();
	if (statusResult.exitCode === 0) {
		for (const line of statusResult.stdout.trim().split("\n")) {
			if (!line) continue;
			const [code, file] = line.split("\t");
			if (!code || !file) continue;
			statuses.set(
				file,
				code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified",
			);
		}
	}

	// Line counts per file
	const numstatResult = await git(
		[...diffArgs, "--numstat", hash, "--", "."],
		{ cwd },
	);

	const results: FileStat[] = [];
	if (numstatResult.exitCode === 0) {
		for (const line of numstatResult.stdout.trim().split("\n")) {
			if (!line) continue;
			const [add, del, file] = line.split("\t");
			if (!file) continue;
			const binary = add === "-" && del === "-";
			results.push({
				file,
				additions: binary ? 0 : parseInt(add) || 0,
				deletions: binary ? 0 : parseInt(del) || 0,
				status: statuses.get(file) ?? "modified",
				binary,
			});
		}
	}

	return results;
}

/**
 * Restore the working tree to a snapshot's state.
 *
 * 1. Finds files created after the snapshot (to delete them)
 * 2. Loads the snapshot tree into the index (read-tree)
 * 3. Force-writes all indexed files to disk (checkout-index)
 * 4. Deletes files that didn't exist in the snapshot
 */
export async function restore(cwd: string, hash: string): Promise<boolean> {
	const dir = gitDir(cwd);

	// Stage current state so diff is accurate
	await addAll(cwd, dir);

	// Find files added since the snapshot (exist now, didn't exist then)
	const addedResult = await git(
		[
			"-c", "core.autocrlf=false",
			"-c", "core.quotepath=false",
			"--git-dir", dir,
			"--work-tree", cwd,
			"diff", "--no-ext-diff", "--name-only", "--diff-filter=A", hash, "--", ".",
		],
		{ cwd },
	);

	const addedFiles =
		addedResult.exitCode === 0
			? addedResult.stdout.trim().split("\n").filter(Boolean)
			: [];

	// Restore all files from the snapshot
	const rt = await git(
		["--git-dir", dir, "--work-tree", cwd, "read-tree", hash],
		{ cwd },
	);
	if (rt.exitCode !== 0) return false;

	const co = await git(
		["--git-dir", dir, "--work-tree", cwd, "checkout-index", "-a", "-f"],
		{ cwd },
	);
	if (co.exitCode !== 0) return false;

	// Delete files that were created after the snapshot
	for (const file of addedFiles) {
		await fs.unlink(path.join(cwd, file)).catch(() => {});
	}

	return true;
}

/**
 * Garbage-collect the shadow repo.
 * Safe to call at any time — idempotent.
 */
export async function cleanup(cwd: string): Promise<void> {
	const dir = gitDir(cwd);

	try {
		await fs.stat(dir);
	} catch {
		return;
	}

	await git(
		["--git-dir", dir, "--work-tree", cwd, "gc", "--prune=7.days"],
		{ cwd },
	);
}
