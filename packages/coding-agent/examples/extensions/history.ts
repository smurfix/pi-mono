/**
 * Persistent History Extension
 *
 * Gives pi bash-style prompt history: prompts are written to a per-project
 * history file on disk and reloaded into the editor's Up/Down-arrow history
 * at the start of every new session.
 *
 * History file location (first match wins):
 *   .pi/history          – project-local (committed or git-ignored, your choice)
 *   ~/.pi/agent/history  – global fallback
 *
 * Commands:
 *   /history [query]   – fuzzy-search history, paste chosen entry into editor
 *   /hist-clear        – clear the active history file after confirmation
 *
 * Requires the addToHistory hook (see the patch in this PR).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 2000;

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/** Return the history file to use for the given working directory. */
function historyFile(cwd: string): string {
	const local = path.join(cwd, ".pi", "history");
	if (fs.existsSync(local)) return local;
	return path.join(os.homedir(), ".pi", "agent", "history");
}

/** Encode a single entry for storage: escape `\` then `\n` so each entry occupies exactly one line. */
function encodeLine(entry: string): string {
	return entry.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** Decode a stored line back to the original entry. */
function decodeLine(line: string): string {
	return line.replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
}

/**
 * Read history file, returning lines newest-first.
 * Blank lines are stripped; stored escape sequences are decoded.
 */
function readHistory(file: string): string[] {
	try {
		return fs
			.readFileSync(file, "utf8")
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.map(decodeLine)
			.reverse(); // file is oldest-first; we want newest-first
	} catch {
		return [];
	}
}

// Last entry written this session – used to suppress consecutive duplicates
// without re-reading the file.
let lastWritten: string | undefined;

/**
 * Append one entry to the history file (oldest-first, one entry per line).
 * Skips if the entry is blank or identical to the last entry appended.
 */
function appendHistory(file: string, text: string): void {
	const entry = text.trim();
	if (!entry) return;
	if (entry === lastWritten) return; // no consecutive duplicates

	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${encodeLine(entry)}\n`);
		lastWritten = entry;
	} catch (err) {
		console.error(`[history] write failed: ${err}`);
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function historyExtension(pi: ExtensionAPI) {
	// ------------------------------------------------------------------
	// On session start: feed the full history into the editor's ring so
	// Up/Down arrows work across sessions from the very first keystroke.
	// ------------------------------------------------------------------
	pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		const file = historyFile(ctx.cwd);
		const entries = readHistory(file); // newest-first
		if (entries.length === 0) return;

		// Trim the file to MAX_ENTRIES now that we've read it, before it grows further.
		if (entries.length > MAX_ENTRIES) {
			const trimmed = entries.slice(0, MAX_ENTRIES); // still newest-first
			try {
				fs.writeFileSync(file, `${trimmed.slice().reverse().join("\n")}\n`);
			} catch (err) {
				console.error(`[history] trim failed: ${err}`);
			}
		}

		// addToHistory prepends to the ring and dedupes consecutive entries.
		// Feed oldest-first so the ring ends up newest-first (matching file order).
		for (let i = entries.length - 1; i >= 0; i--) {
			ctx.ui.addToHistory(entries[i]);
		}
	});

	// ------------------------------------------------------------------
	// After each agent turn: persist the user prompt.
	// ------------------------------------------------------------------
	pi.on("agent_end", (event: AgentEndEvent, ctx: ExtensionContext) => {
		// Find the last user message in this turn.
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const msg = event.messages[i];
			if (msg.role !== "user") continue;

			// Extract plain text from the content (ignore images).
			let text = "";
			if (typeof msg.content === "string") {
				text = msg.content;
			} else if (Array.isArray(msg.content)) {
				text = (msg.content as Array<{ type: string; text?: string }>)
					.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join("\n");
			}

			appendHistory(historyFile(ctx.cwd), text);
			break;
		}
	});

	// ------------------------------------------------------------------
	// /history [query] – search and paste
	// ------------------------------------------------------------------
	pi.registerCommand("history", {
		description: "Search prompt history – /history [query]",
		getArgumentCompletions(prefix: string) {
			// Offer recent entries as completions for the argument.
			const entries = readHistory(historyFile(process.cwd()));
			const hits = entries.filter((e) => e.toLowerCase().includes(prefix.toLowerCase()));
			return hits.slice(0, 30).map((e) => ({
				value: e,
				label: e.length > 80 ? `${e.slice(0, 80)}…` : e,
			}));
		},
		async handler(args: string, ctx: ExtensionCommandContext) {
			const file = historyFile(ctx.cwd);
			const query = args.trim();
			const all = readHistory(file);

			const hits = query ? all.filter((e) => e.toLowerCase().includes(query.toLowerCase())) : all;

			if (hits.length === 0) {
				ctx.ui.notify(query ? `No history matches "${query}"` : "History is empty", "info");
				return;
			}

			const display = hits.slice(0, 50).map((e) => (e.length > 120 ? `${e.slice(0, 120)}…` : e));

			const chosen = await ctx.ui.select(
				query ? `History – "${query}" (${hits.length} matches)` : `History (${hits.length} entries)`,
				display,
			);
			if (chosen) ctx.ui.setEditorText(chosen);
		},
	});

	// ------------------------------------------------------------------
	// /hist-clear – wipe the history file
	// ------------------------------------------------------------------
	pi.registerCommand("hist-clear", {
		description: "Clear the persistent history file",
		async handler(_args: string, ctx: ExtensionCommandContext) {
			const file = historyFile(ctx.cwd);
			const ok = await ctx.ui.confirm("Clear history", `Delete all entries in ${file}?`);
			if (!ok) return;
			try {
				fs.writeFileSync(file, "");
				ctx.ui.notify("History cleared.", "info");
			} catch (err) {
				ctx.ui.notify(`Failed to clear history: ${err}`, "error");
			}
		},
	});
}
