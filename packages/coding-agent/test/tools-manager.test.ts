import type * as ChildProcess from "node:child_process";
import type * as Fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildArgumentGuardLauncher,
	ensureTool,
	getLatestVersion,
	type ToolStatus,
} from "../src/utils/tools-manager.ts";

const originalOffline = process.env.PI_OFFLINE;

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return {
		...actual,
		existsSync: vi.fn(() => false),
	};
});

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcess>();
	return {
		...actual,
		spawnSync: vi.fn(() => ({ error: new Error("not found") })),
	};
});

afterEach(() => {
	if (originalOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = originalOffline;
	vi.unstubAllGlobals();
});

function redirectResponse(location: string): Response {
	return new Response(null, { status: 302, headers: { location } });
}

describe("getLatestVersion", () => {
	it("resolves the version from the release page redirect", async () => {
		const fetchMock = vi.fn(async () => redirectResponse("https://github.com/sharkdp/fd/releases/tag/v10.4.2"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestVersion("sharkdp/fd")).resolves.toBe("10.4.2");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://github.com/sharkdp/fd/releases/latest",
			expect.objectContaining({ redirect: "manual" }),
		);
	});

	it("keeps tags without a v prefix intact", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => redirectResponse("https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0")),
		);

		await expect(getLatestVersion("BurntSushi/ripgrep")).resolves.toBe("15.2.0");
	});

	it("resolves relative redirect targets", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => redirectResponse("/sharkdp/fd/releases/tag/v10.4.2")),
		);

		await expect(getLatestVersion("sharkdp/fd")).resolves.toBe("10.4.2");
	});

	it("discards the redirect response body", async () => {
		const response = new Response("<html></html>", {
			status: 302,
			headers: { location: "https://github.com/sharkdp/fd/releases/tag/v10.4.2" },
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response),
		);

		await expect(getLatestVersion("sharkdp/fd")).resolves.toBe("10.4.2");
		expect(response.bodyUsed).toBe(true);
	});

	it("fails clearly when the endpoint does not redirect", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not found", { status: 404 })),
		);

		await expect(getLatestVersion("sharkdp/fd")).rejects.toThrow(
			"Failed to resolve latest sharkdp/fd release: HTTP 404 without redirect",
		);
	});

	it("fails clearly when the redirect does not point at a release tag", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => redirectResponse("https://github.com/login")),
		);

		await expect(getLatestVersion("sharkdp/fd")).rejects.toThrow(
			"Failed to resolve latest sharkdp/fd release: unexpected redirect to https://github.com/login",
		);
	});
});

describe("ensureTool", () => {
	it("reports status through a callback without writing to the console", async () => {
		process.env.PI_OFFLINE = "1";
		const statuses: ToolStatus[] = [];
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

		const result = await ensureTool("fd", (status) => statuses.push(status));

		expect(result).toBeUndefined();
		expect(statuses).toEqual([
			{
				type: "warning",
				message: "fd not found. Offline mode enabled, skipping download.",
			},
		]);
		expect(consoleLog).not.toHaveBeenCalled();
		consoleLog.mockRestore();
	});

	it("surfaces the error cause chain when a download fails", async () => {
		delete process.env.PI_OFFLINE;
		const cause = new Error("connect ETIMEDOUT 140.82.113.3:443");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed", { cause });
			}),
		);
		const statuses: ToolStatus[] = [];

		const result = await ensureTool("fd", (status) => statuses.push(status));

		expect(result).toBeUndefined();
		expect(statuses).toEqual([
			{ type: "info", message: "fd not found. Downloading..." },
			{
				type: "warning",
				message: "Failed to download fd: fetch failed: connect ETIMEDOUT 140.82.113.3:443",
			},
		]);
	});
});

describe("buildArgumentGuardLauncher", () => {
	it("generates a POSIX launcher delegating to the real path", () => {
		const script = buildArgumentGuardLauncher("/opt/managed/rg.real");
		expect(script.startsWith("#!/bin/sh")).toBe(true);
		expect(script).toContain("exec_real='/opt/managed/rg.real'");
		expect(script).toContain('exec "$exec_real" "$@"');
	});

	it("quotes apostrophes in the real path", () => {
		const script = buildArgumentGuardLauncher("/odd'path/rg.real");
		// Shell single-quote escaping of the embedded apostrophe.
		expect(script).toContain("exec_real='/odd'");
		expect(script).toContain("\\''path/rg.real'");
	});

	// Spawns the generated launcher with representative argv and reports the
	// delegated process's view (via a stand-in executable echoing argv as JSON).
	function spawnLauncher(argv: string[]): { status: number; stderr: string; stdout: string } {
		const { mkdtempSync, writeFileSync } = require("node:fs") as typeof Fs;
		const { spawnSync } = require("node:child_process") as typeof ChildProcess;
		const tmp = mkdtempSync("/tmp/pi-launchertest-");
		const realPath = `${tmp}/rg.real`;
		const launcherPath = `${tmp}/rg`;
		writeFileSync(realPath, "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n", {
			mode: 0o755,
		});
		writeFileSync(launcherPath, buildArgumentGuardLauncher(realPath), { mode: 0o755 });
		const result = spawnSync(launcherPath, argv, { encoding: "utf8" });
		const status = result.status ?? -1;
		const stderr = result.stderr ?? "";
		const stdout = result.stdout ?? "";
		return { status, stderr, stdout };
	}

	it("passes boolean clusters through untouched", () => {
		const r = spawnLauncher(["-in", "--smart-case", "pat", "file"]);
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout.trim())).toEqual(["-in", "--smart-case", "pat", "file"]);
	});

	it("allows -r with separated value", () => {
		const r = spawnLauncher(["-r", "X", "pat", "file"]);
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout.trim())).toEqual(["-r", "X", "pat", "file"]);
	});

	it("refuses a glued cluster attaching a value to -r", () => {
		const r = spawnLauncher(["-rn", "pat", "file"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/-r n/);
		expect(r.stdout).toBe("");
	});

	it("stops scanning at the operand separator", () => {
		const r = spawnLauncher(["--", "-rn", "pat"]);
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout.trim())).toEqual(["--", "-rn", "pat"]);
	});
});
