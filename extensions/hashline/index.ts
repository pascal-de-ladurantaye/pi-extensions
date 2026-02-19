/**
 * Hashline — Content-anchored line editing for pi
 *
 * Overrides the built-in `read`, `edit`, and `grep` tools with a hashline workflow:
 *
 *   read  → outputs each line as `LINE:HASH|content`
 *   grep  → outputs matched lines with `LINE:HASH` anchors
 *   edit  → accepts hash-verified anchors (set_line, replace_lines, insert_after, replace)
 *
 * Hashes are 2-char hex digests (FNV-1a 32-bit) of whitespace-stripped line content.
 * The LLM copies `LINE:HASH` anchors from read output and uses them to target exact
 * lines in edits. Smart heuristics handle line drift, merge detection, echo stripping,
 * indentation recovery, and wrapped-line restoration.
 *
 * Inspired by oh-my-pi and pi-hashline-edit (RimuruW).
 */

import type { ExtensionAPI, EditToolDetails } from "@mariozechner/pi-coding-agent";
import {
	createReadTool,
	createGrepTool,
	truncateHead,
	formatSize,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { createHash } from "crypto";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile, stat as fsStat } from "fs/promises";
import { constants } from "fs";
import { isAbsolute, resolve as resolvePath } from "path";
import path from "path";
import * as os from "os";

// ═══════════════════════════════════════════════════════════════════════════
// Utility helpers
// ═══════════════════════════════════════════════════════════════════════════

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

// ── Path resolution ──────────────────────────────────────────────────────

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function resolveToCwd(filePath: string, cwd: string): string {
	let p = filePath.startsWith("@") ? filePath.slice(1) : filePath;
	p = p.replace(UNICODE_SPACES, " ");
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return os.homedir() + p.slice(1);
	return isAbsolute(p) ? p : resolvePath(cwd, p);
}

// ── Line ending handling ─────────────────────────────────────────────────

function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1 || crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF")
		? { bom: "\uFEFF", text: content.slice(1) }
		: { bom: "", text: content };
}

// ═══════════════════════════════════════════════════════════════════════════
// Hashing
// ═══════════════════════════════════════════════════════════════════════════

const HASH_LEN = 2;
const RADIX = 16;
const HASH_MOD = RADIX ** HASH_LEN; // 256
const DICT = Array.from({ length: HASH_MOD }, (_, i) =>
	i.toString(RADIX).padStart(HASH_LEN, "0"),
);

/**
 * FNV-1a 32-bit hash. Fast, deterministic, no dependencies.
 * We only use the bottom 8 bits (mod 256) so collisions are expected —
 * the line number disambiguates.
 */
function fnv1a32(input: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

function computeLineHash(_idx: number, line: string): string {
	if (line.endsWith("\r")) line = line.slice(0, -1);
	line = line.replace(/\s+/g, "");
	return DICT[fnv1a32(line) % HASH_MOD];
}

// ═══════════════════════════════════════════════════════════════════════════
// Fuzzy text matching (for `replace` fallback edits)
// ═══════════════════════════════════════════════════════════════════════════

const SINGLE_QUOTES_RE = /[\u2018\u2019\u201A\u201B]/g;
const DOUBLE_QUOTES_RE = /[\u201C\u201D\u201E\u201F]/g;
const HYPHENS_RE = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
const UNICODE_SPACES_RE = /[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g;

function normalizeFuzzyChar(ch: string): string {
	return ch
		.replace(SINGLE_QUOTES_RE, "'")
		.replace(DOUBLE_QUOTES_RE, '"')
		.replace(HYPHENS_RE, "-")
		.replace(UNICODE_SPACES_RE, " ");
}

function normalizeForFuzzyMatch(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(SINGLE_QUOTES_RE, "'")
		.replace(DOUBLE_QUOTES_RE, '"')
		.replace(HYPHENS_RE, "-")
		.replace(UNICODE_SPACES_RE, " ");
}

function buildNormalizedWithMap(text: string): {
	normalized: string;
	indexMap: number[];
} {
	const lines = text.split("\n");
	const normalizedChars: string[] = [];
	const indexMap: number[] = [];
	let originalOffset = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.replace(/\s+$/u, "");
		for (let j = 0; j < trimmed.length; j++) {
			normalizedChars.push(normalizeFuzzyChar(trimmed[j]!));
			indexMap.push(originalOffset + j);
		}
		if (i < lines.length - 1) {
			normalizedChars.push("\n");
			indexMap.push(originalOffset + line.length);
		}
		originalOffset += line.length + 1;
	}

	return { normalized: normalizedChars.join(""), indexMap };
}

function mapNormalizedSpanToOriginal(
	indexMap: number[],
	normalizedStart: number,
	normalizedLength: number,
): { index: number; matchLength: number } | null {
	if (normalizedStart < 0 || normalizedLength <= 0) return null;
	const normalizedEnd = normalizedStart + normalizedLength;
	if (normalizedEnd > indexMap.length) return null;
	const start = indexMap[normalizedStart];
	const end = indexMap[normalizedEnd - 1];
	if (start === undefined || end === undefined || end < start) return null;
	return { index: start, matchLength: end - start + 1 };
}

function fuzzyFindText(
	content: string,
	oldText: string,
): { found: boolean; index: number; matchLength: number } {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1)
		return { found: true, index: exactIndex, matchLength: oldText.length };

	const normalizedNeedle = normalizeForFuzzyMatch(oldText);
	if (!normalizedNeedle.length)
		return { found: false, index: -1, matchLength: 0 };

	const { normalized, indexMap } = buildNormalizedWithMap(content);
	const normalizedIndex = normalized.indexOf(normalizedNeedle);
	if (normalizedIndex === -1)
		return { found: false, index: -1, matchLength: 0 };

	const mapped = mapNormalizedSpanToOriginal(
		indexMap,
		normalizedIndex,
		normalizedNeedle.length,
	);
	return mapped
		? { found: true, ...mapped }
		: { found: false, index: -1, matchLength: 0 };
}

function replaceText(
	content: string,
	oldText: string,
	newText: string,
	opts: { all?: boolean },
): { content: string; count: number } {
	if (!oldText.length) return { content, count: 0 };
	const normalizedNew = normalizeToLF(newText);

	if (opts.all) {
		const exactCount = content.split(oldText).length - 1;
		if (exactCount > 0)
			return {
				content: content.split(oldText).join(normalizedNew),
				count: exactCount,
			};

		const normalizedNeedle = normalizeForFuzzyMatch(oldText);
		if (!normalizedNeedle.length) return { content, count: 0 };

		const { normalized, indexMap } = buildNormalizedWithMap(content);
		const spans: Array<{ index: number; matchLength: number }> = [];
		let searchFrom = 0;

		while (searchFrom <= normalized.length - normalizedNeedle.length) {
			const pos = normalized.indexOf(normalizedNeedle, searchFrom);
			if (pos === -1) break;
			const mapped = mapNormalizedSpanToOriginal(
				indexMap,
				pos,
				normalizedNeedle.length,
			);
			if (mapped) {
				const prev = spans[spans.length - 1];
				if (!prev || mapped.index >= prev.index + prev.matchLength)
					spans.push(mapped);
			}
			searchFrom = pos + Math.max(1, normalizedNeedle.length);
		}

		if (!spans.length) return { content, count: 0 };
		let out = content;
		for (let i = spans.length - 1; i >= 0; i--) {
			const span = spans[i]!;
			out =
				out.substring(0, span.index) +
				normalizedNew +
				out.substring(span.index + span.matchLength);
		}
		return { content: out, count: spans.length };
	}

	const result = fuzzyFindText(content, oldText);
	if (!result.found) return { content, count: 0 };
	return {
		content:
			content.substring(0, result.index) +
			normalizedNew +
			content.substring(result.index + result.matchLength),
		count: 1,
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Diff generation (inline — avoids external `diff` dependency)
// ═══════════════════════════════════════════════════════════════════════════

function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLen = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLen).length;

	// Simple LCS-based diff
	const changes = diffLines(oldLines, newLines);
	const output: string[] = [];
	let firstChangedLine: number | undefined;
	let lastChangeIdx = -contextLines - 1;

	// Determine which output indices are within context of a change
	const isChange = changes.map((c) => c.type !== "same");
	const inContext = new Array(changes.length).fill(false);
	for (let i = 0; i < changes.length; i++) {
		if (isChange[i]) {
			for (
				let j = Math.max(0, i - contextLines);
				j <= Math.min(changes.length - 1, i + contextLines);
				j++
			) {
				inContext[j] = true;
			}
		}
	}

	let prevShown = false;
	for (let i = 0; i < changes.length; i++) {
		const c = changes[i];
		if (!inContext[i]) {
			prevShown = false;
			continue;
		}

		if (!prevShown && i > 0) output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
		prevShown = true;

		if (c.type === "remove") {
			if (firstChangedLine === undefined) firstChangedLine = c.newLineNum;
			output.push(
				`-${String(c.oldLineNum).padStart(lineNumWidth, " ")} ${c.text}`,
			);
		} else if (c.type === "add") {
			if (firstChangedLine === undefined) firstChangedLine = c.newLineNum;
			output.push(
				`+${String(c.newLineNum).padStart(lineNumWidth, " ")} ${c.text}`,
			);
		} else {
			output.push(
				` ${String(c.oldLineNum).padStart(lineNumWidth, " ")} ${c.text}`,
			);
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

interface DiffEntry {
	type: "same" | "add" | "remove";
	text: string;
	oldLineNum: number;
	newLineNum: number;
}

/** Simple line diff using a greedy longest-common-subsequence approach. */
function diffLines(oldLines: string[], newLines: string[]): DiffEntry[] {
	// Use patience-style: match unique lines first, then fill gaps
	// For simplicity, use basic Myers-like O(ND) diff for short files,
	// fall back to hash-based for large files

	const result: DiffEntry[] = [];
	let oi = 0;
	let ni = 0;

	// Build lookup of old line positions
	const oldMap = new Map<string, number[]>();
	for (let i = 0; i < oldLines.length; i++) {
		const arr = oldMap.get(oldLines[i]);
		if (arr) arr.push(i);
		else oldMap.set(oldLines[i], [i]);
	}

	// Simple forward scan with lookahead
	while (oi < oldLines.length || ni < newLines.length) {
		if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
			result.push({
				type: "same",
				text: oldLines[oi],
				oldLineNum: oi + 1,
				newLineNum: ni + 1,
			});
			oi++;
			ni++;
			continue;
		}

		// Look ahead for resync
		let bestOld = -1;
		let bestNew = -1;
		let bestCost = Infinity;
		const maxLook = Math.min(50, Math.max(oldLines.length - oi, newLines.length - ni));

		for (let look = 1; look <= maxLook; look++) {
			// Skip `look` old lines
			if (oi + look < oldLines.length && ni < newLines.length && oldLines[oi + look] === newLines[ni]) {
				const cost = look;
				if (cost < bestCost) { bestOld = oi + look; bestNew = ni; bestCost = cost; }
				break;
			}
			// Skip `look` new lines
			if (ni + look < newLines.length && oi < oldLines.length && oldLines[oi] === newLines[ni + look]) {
				const cost = look;
				if (cost < bestCost) { bestOld = oi; bestNew = ni + look; bestCost = cost; }
				break;
			}
		}

		if (bestOld === -1 && bestNew === -1) {
			// No resync found — emit remaining as removes then adds
			while (oi < oldLines.length) {
				result.push({ type: "remove", text: oldLines[oi], oldLineNum: oi + 1, newLineNum: ni + 1 });
				oi++;
			}
			while (ni < newLines.length) {
				result.push({ type: "add", text: newLines[ni], oldLineNum: oi + 1, newLineNum: ni + 1 });
				ni++;
			}
		} else {
			// Emit removals up to bestOld
			while (oi < bestOld) {
				result.push({ type: "remove", text: oldLines[oi], oldLineNum: oi + 1, newLineNum: ni + 1 });
				oi++;
			}
			// Emit additions up to bestNew
			while (ni < bestNew) {
				result.push({ type: "add", text: newLines[ni], oldLineNum: oi + 1, newLineNum: ni + 1 });
				ni++;
			}
		}
	}

	return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// Hashline edit engine
// ═══════════════════════════════════════════════════════════════════════════

type HashlineEditItem =
	| { set_line: { anchor: string; new_text: string } }
	| {
			replace_lines: {
				start_anchor: string;
				end_anchor: string;
				new_text: string;
			};
	  }
	| { insert_after: { anchor: string; text: string } }
	| { replace: { old_text: string; new_text: string; all?: boolean } };

interface HashMismatch {
	line: number;
	expected: string;
	actual: string;
}

type ParsedRef = { line: number; hash: string };

type ParsedSpec =
	| { kind: "single"; ref: ParsedRef }
	| { kind: "range"; start: ParsedRef; end: ParsedRef }
	| { kind: "insertAfter"; after: ParsedRef };

interface ParsedEdit {
	spec: ParsedSpec;
	dstLines: string[];
}

interface NoopEdit {
	editIndex: number;
	loc: string;
	currentContent: string;
}

// ── Constants ────────────────────────────────────────────────────────────

const HASHLINE_PREFIX_RE = /^\d+:[0-9a-zA-Z]{1,16}\|/;
const DIFF_PLUS_RE = /^\+(?!\+)/;
const CONFUSABLE_HYPHENS_RE =
	/[\u2010\u2011\u2012\u2013\u2014\u2212\uFE63\uFF0D]/g;
const HASH_RELOCATION_WINDOW = 20;

// ── Ref parsing ──────────────────────────────────────────────────────────

function parseLineRef(ref: string): ParsedRef {
	const cleaned = ref
		.replace(/\|.*$/, "")
		.replace(/ {2}.*$/, "")
		.trim();
	const normalized = cleaned.replace(/\s*:\s*/, ":");
	const match = normalized.match(
		new RegExp(`^(\\d+):([0-9a-fA-F]{${HASH_LEN}})$`),
	);
	if (!match)
		throw new Error(
			`Invalid line reference "${ref}". Expected "LINE:HASH" (e.g. "5:ab").`,
		);
	const line = Number.parseInt(match[1], 10);
	if (line < 1)
		throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
	return { line, hash: match[2] };
}

// ── Mismatch formatting ─────────────────────────────────────────────────

function formatMismatchError(
	mismatches: HashMismatch[],
	fileLines: string[],
): string {
	const mismatchSet = new Map<number, HashMismatch>();
	for (const m of mismatches) mismatchSet.set(m.line, m);

	const displayLines = new Set<number>();
	for (const m of mismatches) {
		for (
			let i = Math.max(1, m.line - 2);
			i <= Math.min(fileLines.length, m.line + 2);
			i++
		) {
			displayLines.add(i);
		}
	}

	const sorted = [...displayLines].sort((a, b) => a - b);
	const out: string[] = [
		`${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since last read. ` +
			`Auto-relocation checks only within ±${HASH_RELOCATION_WINDOW} lines of each anchor. ` +
			`Use the updated LINE:HASH references shown below (>>> marks changed lines).`,
		"",
	];

	let prev = -1;
	for (const num of sorted) {
		if (prev !== -1 && num > prev + 1) out.push("    ...");
		prev = num;
		const content = fileLines[num - 1];
		const hash = computeLineHash(num, content);
		const prefix = `${num}:${hash}`;
		out.push(
			mismatchSet.has(num)
				? `>>> ${prefix}|${content}`
				: `    ${prefix}|${content}`,
		);
	}

	return out.join("\n");
}

// ── DST preprocessing ────────────────────────────────────────────────────

function splitDst(dst: string): string[] {
	return dst === "" ? [] : dst.split("\n");
}

function stripNewLinePrefixes(lines: string[]): string[] {
	let hashCount = 0;
	let plusCount = 0;
	let nonEmpty = 0;

	for (const l of lines) {
		if (!l.length) continue;
		nonEmpty++;
		if (HASHLINE_PREFIX_RE.test(l)) hashCount++;
		if (DIFF_PLUS_RE.test(l)) plusCount++;
	}

	if (!nonEmpty) return lines;
	const stripHash = hashCount > 0 && hashCount >= nonEmpty * 0.5;
	const stripPlus = !stripHash && plusCount > 0 && plusCount >= nonEmpty * 0.5;
	if (!stripHash && !stripPlus) return lines;

	return lines.map((l) =>
		stripHash
			? l.replace(HASHLINE_PREFIX_RE, "")
			: stripPlus
				? l.replace(DIFF_PLUS_RE, "")
				: l,
	);
}

// ── Whitespace / format helpers ──────────────────────────────────────────

function stripAllWhitespace(s: string): string {
	return s.replace(/\s+/g, "");
}

function stripTrailingContinuationTokens(s: string): string {
	return s.replace(/(?:&&|\|\||\?\?|\?|:|=|,|\+|-|\*|\/|\.|\()\s*$/u, "");
}

function stripMergeOperatorChars(s: string): string {
	return s.replace(/[|&?]/g, "");
}

function normalizeConfusableHyphensInLines(lines: string[]): string[] {
	return lines.map((line) => line.replace(CONFUSABLE_HYPHENS_RE, "-"));
}

function wsEq(a: string, b: string): boolean {
	return a === b || a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

function restoreIndent(tpl: string, line: string): string {
	if (!line.length) return line;
	const indent = tpl.match(/^\s*/)?.[0] ?? "";
	if (
		!indent.length ||
		(line.match(/^\s*/)?.[0] ?? "").length > 0
	)
		return line;
	return indent + line;
}

function restoreIndentPaired(old: string[], next: string[]): string[] {
	if (old.length !== next.length) return next;
	let changed = false;
	const out = next.map((line, i) => {
		const restored = restoreIndent(old[i], line);
		if (restored !== line) changed = true;
		return restored;
	});
	return changed ? out : next;
}

/**
 * When a model splits a single original line into multiple lines (e.g. wrapping
 * a long expression), detect this and restore the original single-line form.
 */
function restoreOldWrappedLines(
	oldLines: string[],
	newLines: string[],
): string[] {
	if (oldLines.length === 0 || newLines.length < 2) return newLines;

	const canonToOld = new Map<string, { line: string; count: number }>();
	for (const line of oldLines) {
		const canon = stripAllWhitespace(line);
		const bucket = canonToOld.get(canon);
		if (bucket) bucket.count++;
		else canonToOld.set(canon, { line, count: 1 });
	}

	const candidates: {
		start: number;
		len: number;
		replacement: string;
		canon: string;
	}[] = [];
	for (let start = 0; start < newLines.length; start++) {
		for (
			let len = 2;
			len <= 10 && start + len <= newLines.length;
			len++
		) {
			const canonSpan = stripAllWhitespace(
				newLines.slice(start, start + len).join(""),
			);
			const old = canonToOld.get(canonSpan);
			if (old && old.count === 1 && canonSpan.length >= 6) {
				candidates.push({
					start,
					len,
					replacement: old.line,
					canon: canonSpan,
				});
			}
		}
	}
	if (candidates.length === 0) return newLines;

	const canonCounts = new Map<string, number>();
	for (const c of candidates)
		canonCounts.set(c.canon, (canonCounts.get(c.canon) ?? 0) + 1);
	const uniqueCandidates = candidates.filter(
		(c) => (canonCounts.get(c.canon) ?? 0) === 1,
	);
	if (uniqueCandidates.length === 0) return newLines;

	uniqueCandidates.sort((a, b) => b.start - a.start);
	const out = [...newLines];
	for (const c of uniqueCandidates) {
		out.splice(c.start, c.len, c.replacement);
	}
	return out;
}

// ── Echo stripping ───────────────────────────────────────────────────────

function stripInsertAnchorEcho(anchorLine: string, dst: string[]): string[] {
	if (dst.length > 1 && wsEq(dst[0], anchorLine)) return dst.slice(1);
	return dst;
}

function stripRangeBoundaryEcho(
	fileLines: string[],
	start: number,
	end: number,
	dst: string[],
): string[] {
	const count = end - start + 1;
	if (dst.length <= 1 || dst.length <= count) return dst;
	let out = dst;
	if (start - 2 >= 0 && wsEq(out[0], fileLines[start - 2]))
		out = out.slice(1);
	if (
		end < fileLines.length &&
		out.length > 0 &&
		wsEq(out[out.length - 1], fileLines[end])
	)
		out = out.slice(0, -1);
	return out;
}

// ── Edit parser ──────────────────────────────────────────────────────────

function parseHashlineEditItem(edit: HashlineEditItem): ParsedEdit {
	if ("set_line" in edit) {
		return {
			spec: { kind: "single", ref: parseLineRef(edit.set_line.anchor) },
			dstLines: stripNewLinePrefixes(splitDst(edit.set_line.new_text)),
		};
	}
	if ("replace_lines" in edit) {
		const start = parseLineRef(edit.replace_lines.start_anchor);
		const end = parseLineRef(edit.replace_lines.end_anchor);
		return {
			spec:
				start.line === end.line
					? { kind: "single", ref: start }
					: { kind: "range", start, end },
			dstLines: stripNewLinePrefixes(splitDst(edit.replace_lines.new_text)),
		};
	}
	if ("insert_after" in edit) {
		return {
			spec: {
				kind: "insertAfter",
				after: parseLineRef(edit.insert_after.anchor),
			},
			dstLines: stripNewLinePrefixes(
				splitDst(edit.insert_after.text ?? ""),
			),
		};
	}
	throw new Error("replace edits are applied separately");
}

// ── Main edit engine ─────────────────────────────────────────────────────

function applyHashlineEdits(
	content: string,
	edits: HashlineEditItem[],
	signal?: AbortSignal,
): {
	content: string;
	firstChangedLine: number | undefined;
	warnings?: string[];
	noopEdits?: NoopEdit[];
} {
	throwIfAborted(signal);
	if (!edits.length) return { content, firstChangedLine: undefined };

	const fileLines = content.split("\n");
	const origLines = [...fileLines];
	let firstChanged: number | undefined;
	const noopEdits: NoopEdit[] = [];

	const parsed: (ParsedEdit & { idx: number })[] = edits.map(
		(edit, idx) => ({
			...parseHashlineEditItem(edit),
			idx,
		}),
	);

	function collectExplicitlyTouchedLines(): Set<number> {
		const touched = new Set<number>();
		for (const { spec } of parsed) {
			if (spec.kind === "single") touched.add(spec.ref.line);
			else if (spec.kind === "insertAfter") touched.add(spec.after.line);
			else
				for (let line = spec.start.line; line <= spec.end.line; line++)
					touched.add(line);
		}
		return touched;
	}
	let explicitlyTouchedLines = collectExplicitlyTouchedLines();

	// Build hash index for local-window relocation
	const lineHashes: string[] = [];
	const hashToLines = new Map<string, number[]>();
	for (let i = 0; i < fileLines.length; i++) {
		throwIfAborted(signal);
		const lineNumber = i + 1;
		const h = computeLineHash(lineNumber, fileLines[i]);
		lineHashes.push(h);
		const lines = hashToLines.get(h);
		if (lines) lines.push(lineNumber);
		else hashToLines.set(h, [lineNumber]);
	}

	const relocationNotes = new Set<string>();

	function findRelocationLine(
		expectedHash: string,
		hintLine: number,
	): number | undefined {
		const candidates = hashToLines.get(expectedHash);
		if (!candidates?.length) return undefined;
		const minLine = Math.max(1, hintLine - HASH_RELOCATION_WINDOW);
		const maxLine = Math.min(
			fileLines.length,
			hintLine + HASH_RELOCATION_WINDOW,
		);
		let match: number | undefined;
		for (const candidate of candidates) {
			if (candidate < minLine || candidate > maxLine) continue;
			if (match !== undefined) return undefined; // ambiguous
			match = candidate;
		}
		return match;
	}

	// Validate all refs before mutation
	const mismatches: HashMismatch[] = [];

	function validate(ref: ParsedRef): boolean {
		if (ref.line < 1 || ref.line > fileLines.length)
			throw new Error(
				`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`,
			);
		const expected = ref.hash.toLowerCase();
		const originalLine = ref.line;
		const actual = lineHashes[originalLine - 1];
		if (actual === expected) return true;
		const relocated = findRelocationLine(expected, originalLine);
		if (relocated !== undefined) {
			ref.line = relocated;
			relocationNotes.add(
				`Auto-relocated anchor ${originalLine}:${ref.hash} -> ${relocated}:${ref.hash} (window ±${HASH_RELOCATION_WINDOW}).`,
			);
			return true;
		}
		mismatches.push({ line: originalLine, expected: ref.hash, actual });
		return false;
	}

	for (const { spec } of parsed) {
		throwIfAborted(signal);
		if (spec.kind === "single") {
			validate(spec.ref);
		} else if (spec.kind === "insertAfter") {
			validate(spec.after);
		} else {
			if (spec.start.line > spec.end.line)
				throw new Error(
					`Range start line ${spec.start.line} must be <= end line ${spec.end.line}`,
				);

			const originalStart = spec.start.line;
			const originalEnd = spec.end.line;
			const originalCount = originalEnd - originalStart + 1;

			const startOk = validate(spec.start);
			const endOk = validate(spec.end);

			if (startOk && endOk) {
				const relocatedCount = spec.end.line - spec.start.line + 1;
				const invalidRange = spec.start.line > spec.end.line;
				const scopeChanged = relocatedCount !== originalCount;
				if (invalidRange || scopeChanged) {
					spec.start.line = originalStart;
					spec.end.line = originalEnd;
					mismatches.push(
						{
							line: originalStart,
							expected: spec.start.hash,
							actual: lineHashes[originalStart - 1],
						},
						{
							line: originalEnd,
							expected: spec.end.hash,
							actual: lineHashes[originalEnd - 1],
						},
					);
				}
			}
		}
	}
	if (mismatches.length)
		throw new Error(formatMismatchError(mismatches, fileLines));

	// Recompute after potential relocation
	explicitlyTouchedLines = collectExplicitlyTouchedLines();

	// Deduplicate identical edits
	const seen = new Map<string, number>();
	const dupes = new Set<number>();
	for (let i = 0; i < parsed.length; i++) {
		throwIfAborted(signal);
		const p = parsed[i];
		const lk =
			p.spec.kind === "single"
				? `s:${p.spec.ref.line}`
				: p.spec.kind === "range"
					? `r:${p.spec.start.line}:${p.spec.end.line}`
					: `i:${p.spec.after.line}`;
		const key = `${lk}|${p.dstLines.join("\n")}`;
		if (seen.has(key)) dupes.add(i);
		else seen.set(key, i);
	}
	const deduped = parsed.filter((_, i) => !dupes.has(i));

	// Sort bottom-up for stable splice
	const sorted = deduped
		.map((p) => {
			const sl =
				p.spec.kind === "single"
					? p.spec.ref.line
					: p.spec.kind === "range"
						? p.spec.end.line
						: p.spec.after.line;
			const pr = p.spec.kind === "insertAfter" ? 1 : 0;
			return { ...p, sl, pr };
		})
		.sort((a, b) => b.sl - a.sl || a.pr - b.pr || a.idx - b.idx);

	function track(line: number) {
		if (firstChanged === undefined || line < firstChanged)
			firstChanged = line;
	}

	function maybeExpandSingleLineMerge(
		line: number,
		dst: string[],
	): {
		startLine: number;
		deleteCount: number;
		newLines: string[];
	} | null {
		if (dst.length !== 1) return null;
		if (line < 1 || line > fileLines.length) return null;

		const newLine = dst[0];
		const newCanon = stripAllWhitespace(newLine);
		const newCanonForMergeOps = stripMergeOperatorChars(newCanon);
		if (!newCanon.length) return null;

		const orig = fileLines[line - 1];
		const origCanon = stripAllWhitespace(orig);
		const origCanonForMatch =
			stripTrailingContinuationTokens(origCanon);
		const origCanonForMergeOps = stripMergeOperatorChars(origCanon);
		const origLooksLikeContinuation =
			origCanonForMatch.length < origCanon.length;
		if (!origCanon.length) return null;

		const nextIdx = line;
		const prevIdx = line - 2;

		// Case A: dst absorbed the next continuation line
		if (
			origLooksLikeContinuation &&
			nextIdx < fileLines.length &&
			!explicitlyTouchedLines.has(line + 1)
		) {
			const next = fileLines[nextIdx];
			const nextCanon = stripAllWhitespace(next);
			const a = newCanon.indexOf(origCanonForMatch);
			const b = newCanon.indexOf(nextCanon);
			if (
				a !== -1 &&
				b !== -1 &&
				a < b &&
				newCanon.length <= origCanon.length + nextCanon.length + 32
			) {
				return { startLine: line, deleteCount: 2, newLines: [newLine] };
			}
		}

		// Case B: dst absorbed the previous continuation line
		if (prevIdx >= 0 && !explicitlyTouchedLines.has(line - 1)) {
			const prev = fileLines[prevIdx];
			const prevCanon = stripAllWhitespace(prev);
			const prevCanonForMatch =
				stripTrailingContinuationTokens(prevCanon);
			const prevLooksLikeContinuation =
				prevCanonForMatch.length < prevCanon.length;
			if (!prevLooksLikeContinuation) return null;
			const a = newCanonForMergeOps.indexOf(
				stripMergeOperatorChars(prevCanonForMatch),
			);
			const b = newCanonForMergeOps.indexOf(origCanonForMergeOps);
			if (
				a !== -1 &&
				b !== -1 &&
				a < b &&
				newCanon.length <=
					prevCanon.length + origCanon.length + 32
			) {
				return {
					startLine: line - 1,
					deleteCount: 2,
					newLines: [newLine],
				};
			}
		}

		return null;
	}

	// Apply edits bottom-up
	for (const { spec, dstLines, idx } of sorted) {
		throwIfAborted(signal);
		if (spec.kind === "single") {
			const merged = maybeExpandSingleLineMerge(
				spec.ref.line,
				dstLines,
			);
			if (merged) {
				const orig = origLines.slice(
					merged.startLine - 1,
					merged.startLine - 1 + merged.deleteCount,
				);
				let newL = restoreIndentPaired(
					[orig[0] ?? ""],
					merged.newLines,
				);
				if (
					orig.join("\n") === newL.join("\n") &&
					orig.some((line) => CONFUSABLE_HYPHENS_RE.test(line))
				) {
					newL = normalizeConfusableHyphensInLines(newL);
				}
				if (orig.join("\n") === newL.join("\n")) {
					noopEdits.push({
						editIndex: idx,
						loc: `${spec.ref.line}:${spec.ref.hash}`,
						currentContent: orig.join("\n"),
					});
					continue;
				}
				fileLines.splice(
					merged.startLine - 1,
					merged.deleteCount,
					...newL,
				);
				track(merged.startLine);
				continue;
			}

			const orig = origLines.slice(
				spec.ref.line - 1,
				spec.ref.line,
			);
			let stripped = stripRangeBoundaryEcho(
				origLines,
				spec.ref.line,
				spec.ref.line,
				dstLines,
			);
			stripped = restoreOldWrappedLines(orig, stripped);
			let newL = restoreIndentPaired(orig, stripped);
			if (
				orig.join("\n") === newL.join("\n") &&
				orig.some((line) => CONFUSABLE_HYPHENS_RE.test(line))
			) {
				newL = normalizeConfusableHyphensInLines(newL);
			}
			if (orig.join("\n") === newL.join("\n")) {
				noopEdits.push({
					editIndex: idx,
					loc: `${spec.ref.line}:${spec.ref.hash}`,
					currentContent: orig.join("\n"),
				});
				continue;
			}
			fileLines.splice(spec.ref.line - 1, 1, ...newL);
			track(spec.ref.line);
		} else if (spec.kind === "range") {
			const count = spec.end.line - spec.start.line + 1;
			const orig = origLines.slice(
				spec.start.line - 1,
				spec.start.line - 1 + count,
			);
			let stripped = stripRangeBoundaryEcho(
				origLines,
				spec.start.line,
				spec.end.line,
				dstLines,
			);
			stripped = restoreOldWrappedLines(orig, stripped);
			let newL = restoreIndentPaired(orig, stripped);
			if (
				orig.join("\n") === newL.join("\n") &&
				orig.some((line) => CONFUSABLE_HYPHENS_RE.test(line))
			) {
				newL = normalizeConfusableHyphensInLines(newL);
			}
			if (orig.join("\n") === newL.join("\n")) {
				noopEdits.push({
					editIndex: idx,
					loc: `${spec.start.line}:${spec.start.hash}`,
					currentContent: orig.join("\n"),
				});
				continue;
			}
			fileLines.splice(spec.start.line - 1, count, ...newL);
			track(spec.start.line);
		} else {
			const anchor = origLines[spec.after.line - 1];
			const inserted = stripInsertAnchorEcho(anchor, dstLines);
			if (!inserted.length) {
				noopEdits.push({
					editIndex: idx,
					loc: `${spec.after.line}:${spec.after.hash}`,
					currentContent: anchor,
				});
				continue;
			}
			fileLines.splice(spec.after.line, 0, ...inserted);
			track(spec.after.line + 1);
		}
	}

	const warnings: string[] = [...relocationNotes];
	let diff = Math.abs(fileLines.length - origLines.length);
	for (
		let i = 0;
		i < Math.min(fileLines.length, origLines.length);
		i++
	) {
		if (fileLines[i] !== origLines[i]) diff++;
	}
	if (diff > edits.length * 4) {
		warnings.push(
			`Edit changed ${diff} lines across ${edits.length} operations — verify no unintended reformatting.`,
		);
	}

	return {
		content: fileLines.join("\n"),
		firstChangedLine: firstChanged,
		...(warnings.length ? { warnings } : {}),
		...(noopEdits.length ? { noopEdits } : {}),
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool definitions
// ═══════════════════════════════════════════════════════════════════════════

const READ_DESC = `Read a file. For text files, each line is prefixed with \`LINE:HASH|\` (e.g., \`12:ab|content\`). Use these references as anchors for the \`edit\` tool.

Images (jpg, png, gif, webp) are sent as attachments.
Default limit: ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`;

const EDIT_DESC = `Surgically edit files with hash-verified line references (anchors). Use the \`LINE:HASH\` strings from the latest \`read\` output to specify exactly where to make changes.

- path: File path
- edits: Array of operations:
  - { set_line: { anchor, new_text } }              // Replace or delete a single line
  - { replace_lines: { start_anchor, end_anchor, new_text } } // Replace a range
  - { insert_after: { anchor, text } }              // Insert after anchor
  - { replace: { old_text, new_text, all? } }       // Global string replace (fallback)

Rules:
- Anchors (\`LINE:HASH\`) must be copied exactly from \`read\` output.
- \`new_text\` is plain content (no hashes, no diff \`+\` markers).
- If a hash mismatch occurs (indicated by \`>>>\`), re-read the file to sync.
- Operations are validated and applied bottom-up atomically.`;

// ── Edit schema ──────────────────────────────────────────────────────────

const hashlineEditItemSchema = Type.Union([
	Type.Object(
		{
			set_line: Type.Object({
				anchor: Type.String(),
				new_text: Type.String(),
			}),
		},
		{ additionalProperties: true },
	),
	Type.Object(
		{
			replace_lines: Type.Object({
				start_anchor: Type.String(),
				end_anchor: Type.String(),
				new_text: Type.String(),
			}),
		},
		{ additionalProperties: true },
	),
	Type.Object(
		{
			insert_after: Type.Object({
				anchor: Type.String(),
				text: Type.String(),
			}),
		},
		{ additionalProperties: true },
	),
	Type.Object(
		{
			replace: Type.Object({
				old_text: Type.String(),
				new_text: Type.String(),
				all: Type.Optional(Type.Boolean()),
			}),
		},
		{ additionalProperties: true },
	),
]);

const hashlineEditSchema = Type.Object(
	{
		path: Type.String({ description: "File path (relative or absolute)" }),
		edits: Type.Optional(
			Type.Array(hashlineEditItemSchema, {
				description: "Array of edit operations",
			}),
		),
	},
	{ additionalProperties: true },
);

type HashlineParams = Static<typeof hashlineEditSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI): void {
	// ── Read tool ────────────────────────────────────────────────────────

	pi.registerTool({
		name: "read",
		label: "Read",
		description: READ_DESC,
		parameters: Type.Object({
			path: Type.String({
				description:
					"Path to the file to read (relative or absolute)",
			}),
			offset: Type.Optional(
				Type.Number({
					description:
						"Line number to start reading from (1-indexed)",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of lines to read",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const rawPath = params.path.replace(/^@/, "");
			const absolutePath = resolveToCwd(rawPath, ctx.cwd);

			throwIfAborted(signal);
			try {
				await fsAccess(absolutePath, constants.R_OK);
			} catch {
				return {
					content: [
						{
							type: "text",
							text: `File not found or not readable: ${rawPath}`,
						},
					],
					isError: true,
					details: {},
				};
			}

			throwIfAborted(signal);
			const pathStat = await fsStat(absolutePath);
			if (pathStat.isDirectory()) {
				return {
					content: [
						{
							type: "text",
							text: `Path is a directory: ${rawPath}. Use ls to inspect directories.`,
						},
					],
					isError: true,
					details: {},
				};
			}

			// Delegate images to the built-in read tool
			throwIfAborted(signal);
			const ext = rawPath.split(".").pop()?.toLowerCase() ?? "";
			if (
				["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(
					ext,
				)
			) {
				const builtinRead = createReadTool(ctx.cwd);
				return builtinRead.execute(
					_toolCallId,
					params,
					signal,
					_onUpdate,
				);
			}

			throwIfAborted(signal);
			const raw = (await fsReadFile(absolutePath)).toString("utf-8");
			throwIfAborted(signal);

			const normalized = normalizeToLF(stripBom(raw).text);
			const allLines = normalized.split("\n");
			const total = allLines.length;

			const startLine = params.offset
				? Math.max(1, params.offset)
				: 1;
			const endIdx = params.limit
				? Math.min(startLine - 1 + params.limit, total)
				: total;
			const selected = allLines.slice(startLine - 1, endIdx);

			const formatted = selected
				.map((line, i) => {
					const num = startLine + i;
					return `${num}:${computeLineHash(num, line)}|${line}`;
				})
				.join("\n");

			const truncation = truncateHead(formatted, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			let text = truncation.content;

			if (truncation.truncated) {
				text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${total} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Use offset=${startLine + truncation.outputLines} to continue.]`;
			} else if (endIdx < total) {
				text += `\n\n[Showing lines ${startLine}-${endIdx} of ${total}. Use offset=${endIdx + 1} to continue.]`;
			}

			return {
				content: [{ type: "text", text }],
				details: {
					truncation: truncation.truncated ? truncation : undefined,
				},
			};
		},
	});

	// ── Edit tool ────────────────────────────────────────────────────────

	pi.registerTool({
		name: "edit",
		label: "Edit",
		description: EDIT_DESC,
		parameters: hashlineEditSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const parsed = params as HashlineParams;
			const input = params as Record<string, unknown>;
			const rawPath = parsed.path;
			const path = rawPath.replace(/^@/, "");
			const absolutePath = resolveToCwd(path, ctx.cwd);
			throwIfAborted(signal);

			// ── Legacy oldText/newText fallback ──
			const legacyOldText =
				typeof input.oldText === "string"
					? input.oldText
					: typeof input.old_text === "string"
						? input.old_text
						: undefined;
			const legacyNewText =
				typeof input.newText === "string"
					? input.newText
					: typeof input.new_text === "string"
						? input.new_text
						: undefined;
			const hasLegacyInput =
				legacyOldText !== undefined || legacyNewText !== undefined;
			const hasEditsInput = Array.isArray(parsed.edits);

			let edits = parsed.edits ?? [];
			let legacyNormalizationWarning: string | undefined;

			if (!hasEditsInput && hasLegacyInput) {
				if (
					legacyOldText === undefined ||
					legacyNewText === undefined
				) {
					throw new Error(
						"Legacy edit input requires both oldText/newText (or old_text/new_text) when 'edits' is omitted.",
					);
				}
				edits = [
					{
						replace: {
							old_text: legacyOldText,
							new_text: legacyNewText,
							...(typeof input.all === "boolean"
								? { all: input.all }
								: {}),
						},
					},
				];
				legacyNormalizationWarning =
					"Legacy top-level oldText/newText input was normalized to edits[0].replace. Prefer the edits[] format.";
			}

			if (!edits.length) {
				return {
					content: [
						{ type: "text", text: "No edits provided." },
					],
					isError: true,
					details: {
						diff: "",
						firstChangedLine: undefined,
					} as EditToolDetails,
				};
			}

			// Validate edit variant keys
			for (let i = 0; i < edits.length; i++) {
				throwIfAborted(signal);
				const e = edits[i] as Record<string, unknown>;
				if (
					("old_text" in e || "new_text" in e) &&
					!("replace" in e)
				) {
					throw new Error(
						`edits[${i}] has top-level 'old_text'/'new_text'. Use {replace: {old_text, new_text}} or {set_line}, {replace_lines}, {insert_after}.`,
					);
				}
				if ("diff" in e) {
					throw new Error(
						`edits[${i}] contains 'diff' from patch mode. Hashline edit expects one of: {set_line}, {replace_lines}, {insert_after}, {replace}.`,
					);
				}
				const variantCount =
					Number("set_line" in e) +
					Number("replace_lines" in e) +
					Number("insert_after" in e) +
					Number("replace" in e);
				if (variantCount !== 1) {
					throw new Error(
						`edits[${i}] must contain exactly one of: 'set_line', 'replace_lines', 'insert_after', 'replace'. Got: [${Object.keys(e).join(", ")}].`,
					);
				}
			}

			const anchorEdits = edits.filter(
				(e): e is HashlineEditItem =>
					"set_line" in e ||
					"replace_lines" in e ||
					"insert_after" in e,
			);
			const replaceEdits = edits.filter(
				(
					e,
				): e is {
					replace: {
						old_text: string;
						new_text: string;
						all?: boolean;
					};
				} => "replace" in e,
			);

			try {
				await fsAccess(
					absolutePath,
					constants.R_OK | constants.W_OK,
				);
			} catch {
				throw new Error(`File not found: ${path}`);
			}
			throwIfAborted(signal);

			const raw = (await fsReadFile(absolutePath)).toString("utf-8");
			throwIfAborted(signal);

			const { bom, text: fileContent } = stripBom(raw);
			const originalEnding = detectLineEnding(fileContent);
			const originalNormalized = normalizeToLF(fileContent);
			let result = originalNormalized;

			const anchorResult = applyHashlineEdits(
				result,
				anchorEdits,
				signal,
			);
			result = anchorResult.content;

			for (const r of replaceEdits) {
				throwIfAborted(signal);
				if (!r.replace.old_text.length)
					throw new Error(
						"replace.old_text must not be empty.",
					);
				const rep = replaceText(
					result,
					r.replace.old_text,
					r.replace.new_text,
					{ all: r.replace.all ?? false },
				);
				if (!rep.count)
					throw new Error(
						`Could not find text to replace in ${path}.`,
					);
				result = rep.content;
			}

			if (originalNormalized === result) {
				let diagnostic = `No changes made to ${path}. The edits produced identical content.`;
				if (anchorResult.noopEdits?.length) {
					diagnostic +=
						"\n" +
						anchorResult.noopEdits
							.map(
								(e) =>
									`Edit ${e.editIndex}: replacement for ${e.loc} is identical to current content:\n  ${e.loc}| ${e.currentContent}`,
							)
							.join("\n");
					diagnostic +=
						"\nRe-read the file to see the current state.";
				} else {
					const lines = result.split("\n");
					const targetLines: string[] = [];
					for (const edit of edits) {
						const refs: string[] = [];
						if ("set_line" in edit)
							refs.push(
								(edit as any).set_line.anchor,
							);
						else if ("replace_lines" in edit) {
							refs.push(
								(edit as any).replace_lines
									.start_anchor,
								(edit as any).replace_lines
									.end_anchor,
							);
						} else if ("insert_after" in edit)
							refs.push(
								(edit as any).insert_after.anchor,
							);
						for (const ref of refs) {
							try {
								const p = parseLineRef(ref);
								if (
									p.line >= 1 &&
									p.line <= lines.length
								) {
									const lineContent =
										lines[p.line - 1];
									const hash = computeLineHash(
										p.line,
										lineContent,
									);
									targetLines.push(
										`${p.line}:${hash}|${lineContent}`,
									);
								}
							} catch {
								/* skip malformed refs */
							}
						}
					}
					if (targetLines.length > 0) {
						const preview = [...new Set(targetLines)]
							.slice(0, 5)
							.join("\n");
						diagnostic += `\nThe file currently contains:\n${preview}\nYour edits were normalized back to the original content. Ensure your replacement changes actual code, not just formatting.`;
					}
				}
				throw new Error(diagnostic);
			}

			throwIfAborted(signal);
			await fsWriteFile(
				absolutePath,
				bom + restoreLineEndings(result, originalEnding),
				"utf-8",
			);

			const diffResult = generateDiffString(
				originalNormalized,
				result,
			);
			const warnings: string[] = [];
			if (anchorResult.warnings?.length)
				warnings.push(...anchorResult.warnings);
			if (legacyNormalizationWarning)
				warnings.push(legacyNormalizationWarning);
			const warn = warnings.length
				? `\n\nWarnings:\n${warnings.join("\n")}`
				: "";

			return {
				content: [
					{ type: "text", text: `Updated ${path}${warn}` },
				],
				details: {
					diff: diffResult.diff,
					firstChangedLine:
						anchorResult.firstChangedLine ??
						diffResult.firstChangedLine,
				} as EditToolDetails,
			};
		},
	});

	// ── Grep tool ────────────────────────────────────────────────────────

	const GREP_DESC =
		"Search file contents for a pattern. Returns matching lines with LINE:HASH anchors for hashline edit workflows.";

	const grepSchema = Type.Object({
		pattern: Type.String({
			description: "Search pattern (regex or literal string)",
		}),
		path: Type.Optional(
			Type.String({
				description:
					"Directory or file to search (default: current directory)",
			}),
		),
		glob: Type.Optional(
			Type.String({
				description:
					"Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
			}),
		),
		ignoreCase: Type.Optional(
			Type.Boolean({
				description: "Case-insensitive search (default: false)",
			}),
		),
		literal: Type.Optional(
			Type.Boolean({
				description:
					"Treat pattern as literal string instead of regex (default: false)",
			}),
		),
		context: Type.Optional(
			Type.Number({
				description:
					"Number of lines to show before and after each match (default: 0)",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description:
					"Maximum number of matches to return (default: 100)",
			}),
		),
	});

	const MATCH_LINE_RE = /^(.*):(\d+): (.*)$/;
	const CONTEXT_LINE_RE = /^(.*)-(\d+)- (.*)$/;

	function parseGrepOutputLine(
		line: string,
	):
		| {
				kind: "match";
				displayPath: string;
				lineNumber: number;
				text: string;
		  }
		| {
				kind: "context";
				displayPath: string;
				lineNumber: number;
				text: string;
		  }
		| null {
		const match = line.match(MATCH_LINE_RE);
		if (match) {
			return {
				kind: "match",
				displayPath: match[1],
				lineNumber: Number.parseInt(match[2], 10),
				text: match[3],
			};
		}
		const context = line.match(CONTEXT_LINE_RE);
		if (context) {
			return {
				kind: "context",
				displayPath: context[1],
				lineNumber: Number.parseInt(context[2], 10),
				text: context[3],
			};
		}
		return null;
	}

	pi.registerTool({
		name: "grep",
		label: "grep",
		description: GREP_DESC,
		parameters: grepSchema,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Delegate to built-in grep, then post-process output with hashline anchors
			const builtin = createGrepTool(ctx.cwd);
			const result = await builtin.execute(
				toolCallId,
				params,
				signal,
				onUpdate,
			);

			const textBlock = result.content?.find(
				(item): item is { type: "text"; text: string } =>
					item.type === "text" &&
					"text" in item &&
					typeof (item as { text?: unknown }).text === "string",
			);
			if (!textBlock?.text) return result;

			const rawSearchPath =
				(params as { path?: string }).path || ".";
			const searchPath = resolveToCwd(rawSearchPath, ctx.cwd);

			let searchPathIsDirectory = false;
			try {
				searchPathIsDirectory = (
					await fsStat(searchPath)
				).isDirectory();
			} catch {
				searchPathIsDirectory = false;
			}

			// Cache file contents to avoid re-reading per matched line
			const fileCache = new Map<string, string[]>();
			const getFileLines = async (
				absolutePath: string,
			): Promise<string[] | undefined> => {
				throwIfAborted(signal);
				if (fileCache.has(absolutePath))
					return fileCache.get(absolutePath);
				try {
					const raw = (
						await fsReadFile(absolutePath)
					).toString("utf-8");
					const lines = normalizeToLF(stripBom(raw).text).split(
						"\n",
					);
					fileCache.set(absolutePath, lines);
					return lines;
				} catch {
					fileCache.set(absolutePath, []);
					return undefined;
				}
			};

			const toAbsolutePath = (displayPath: string): string => {
				if (searchPathIsDirectory)
					return path.resolve(searchPath, displayPath);
				return searchPath;
			};

			const transformed: string[] = [];
			let parsedCount = 0;
			let candidateUnparsedCount = 0;
			const candidateLinePattern = /^.+(?::|-)\d+(?::|-)\s/;

			for (const line of textBlock.text.split("\n")) {
				throwIfAborted(signal);
				const parsed = parseGrepOutputLine(line);
				if (
					!parsed ||
					!Number.isFinite(parsed.lineNumber) ||
					parsed.lineNumber < 1
				) {
					if (candidateLinePattern.test(line))
						candidateUnparsedCount++;
					transformed.push(line);
					continue;
				}

				parsedCount++;
				const absolute = toAbsolutePath(parsed.displayPath);
				const fileLines = await getFileLines(absolute);
				const sourceLine =
					fileLines?.[parsed.lineNumber - 1] ?? parsed.text;
				const ref = `${parsed.lineNumber}:${computeLineHash(parsed.lineNumber, sourceLine)}`;
				const marker = parsed.kind === "match" ? ">>" : "  ";
				transformed.push(
					`${parsed.displayPath}:${marker}${ref}|${parsed.text}`,
				);
			}

			// If we couldn't parse any lines, pass through with a warning
			if (parsedCount === 0 && candidateUnparsedCount > 0) {
				const warning =
					"[hashline grep passthrough] Unparsed grep format; returned original output.";
				const passthroughDetails =
					typeof result.details === "object" &&
					result.details !== null
						? (result.details as Record<string, unknown>)
						: {};
				return {
					...result,
					content: result.content.map((item) =>
						item === textBlock
							? ({
									...item,
									text: `${textBlock.text}\n\n${warning}`,
								} as typeof item)
							: item,
					),
					details: {
						...passthroughDetails,
						hashlinePassthrough: true,
						hashlineWarning: warning,
					},
				};
			}

			return {
				...result,
				content: result.content.map((item) =>
					item === textBlock
						? ({
								...item,
								text: transformed.join("\n"),
							} as typeof item)
						: item,
				),
			};
		},
	});

	// ── Session start notification ───────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const debugValue = process.env.PI_HASHLINE_DEBUG;
		if (debugValue === "1" || debugValue === "true") {
			ctx.ui.notify("Hashline mode active", "info");
		}
	});
}
