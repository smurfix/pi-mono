import * as fs from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Agent, type Dispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTraceInterceptor } from "../src/core/http-trace.ts";

interface TraceEvent {
	type: "request" | "response" | "error";
	id: number;
	ts: string;
	method?: string;
	url?: string;
	headers?: Record<string, string | string[]>;
	status?: number;
	statusText?: string;
	body?: { kind: string; data?: unknown; base64?: string; bytes?: number; description?: string };
	partialBody?: { kind: string; data?: unknown };
	error?: string;
	durationMs?: number;
}

function readTrace(file: string): TraceEvent[] {
	const text = fs.readFileSync(file, "utf8");
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as TraceEvent);
}

function makeWriter(file: string): (event: Record<string, unknown>) => void {
	const stream = fs.createWriteStream(file, { flags: "a" });
	return (event) => stream.write(`${JSON.stringify(event)}\n`);
}

async function dispatchOnce(
	dispatcher: Dispatcher,
	options: Dispatcher.RequestOptions,
): Promise<{ status: number; body: Buffer }> {
	const response = await dispatcher.request(options);
	const chunks: Buffer[] = [];
	for await (const chunk of response.body) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return { status: response.statusCode, body: Buffer.concat(chunks) };
}

describe("http trace interceptor", () => {
	let server: http.Server;
	let baseUrl: string;
	let dir: string;

	beforeAll(async () => {
		dir = fs.mkdtempSync(path.join(tmpdir(), "pi-trace-"));
		server = http.createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				const body = Buffer.concat(chunks);
				if (req.url === "/json") {
					res.writeHead(200, { "content-type": "application/json", "x-echo-len": String(body.length) });
					res.end(JSON.stringify({ echo: JSON.parse(body.toString() || "null") }));
					return;
				}
				if (req.url === "/binary") {
					res.writeHead(200, { "content-type": "application/octet-stream" });
					res.end(Buffer.from([0, 1, 2, 3, 0xff, 0xfe]));
					return;
				}
				if (req.url === "/text") {
					res.writeHead(418, { "content-type": "text/plain" });
					res.end("not json at all");
					return;
				}
				if (req.url === "/server-error") {
					res.socket?.destroy();
					return;
				}
				res.writeHead(404);
				res.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const addr = server.address();
		if (!addr || typeof addr === "string") throw new Error("server failed to bind");
		baseUrl = `http://127.0.0.1:${addr.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("logs JSON request and JSON response", async () => {
		const file = path.join(dir, "json.jsonl");
		const dispatcher = new Agent().compose(createTraceInterceptor(makeWriter(file)));

		const { status, body } = await dispatchOnce(dispatcher, {
			origin: baseUrl,
			path: "/json",
			method: "POST",
			headers: { "content-type": "application/json", "x-test": "hi" },
			body: JSON.stringify({ hello: "world" }),
		});
		expect(status).toBe(200);
		expect(JSON.parse(body.toString())).toEqual({ echo: { hello: "world" } });
		await dispatcher.close();

		const events = readTrace(file);
		expect(events).toHaveLength(2);
		const [req, res] = events;
		expect(req.type).toBe("request");
		expect(req.method).toBe("POST");
		expect(req.url).toBe(`${baseUrl}/json`);
		expect(req.headers?.["x-test"]).toBe("hi");
		expect(req.body).toEqual({ kind: "json", data: { hello: "world" } });

		expect(res.type).toBe("response");
		expect(res.status).toBe(200);
		expect(res.headers?.["content-type"]).toBe("application/json");
		expect(res.body).toEqual({ kind: "json", data: { echo: { hello: "world" } } });
		expect(typeof res.durationMs).toBe("number");
		expect(req.id).toBe(res.id);
	});

	test("logs raw text body when content-type is not JSON", async () => {
		const file = path.join(dir, "text.jsonl");
		const dispatcher = new Agent().compose(createTraceInterceptor(makeWriter(file)));

		const { status } = await dispatchOnce(dispatcher, {
			origin: baseUrl,
			path: "/text",
			method: "GET",
		});
		expect(status).toBe(418);
		await dispatcher.close();

		const events = readTrace(file);
		expect(events).toHaveLength(2);
		const [, res] = events;
		expect(res.status).toBe(418);
		expect(res.body).toEqual({ kind: "text", data: "not json at all" });
	});

	test("logs binary body as base64", async () => {
		const file = path.join(dir, "binary.jsonl");
		const dispatcher = new Agent().compose(createTraceInterceptor(makeWriter(file)));

		await dispatchOnce(dispatcher, {
			origin: baseUrl,
			path: "/binary",
			method: "GET",
		});
		await dispatcher.close();

		const [, res] = readTrace(file);
		expect(res.body?.kind).toBe("binary");
		expect(res.body?.bytes).toBe(6);
		expect(Buffer.from(res.body!.base64!, "base64")).toEqual(Buffer.from([0, 1, 2, 3, 0xff, 0xfe]));
	});

	test("logs error event when the connection drops", async () => {
		const file = path.join(dir, "error.jsonl");
		const dispatcher = new Agent().compose(createTraceInterceptor(makeWriter(file)));

		await expect(
			dispatcher.request({
				origin: baseUrl,
				path: "/server-error",
				method: "GET",
			}),
		).rejects.toBeDefined();
		await dispatcher.close();

		const events = readTrace(file);
		expect(events.length).toBeGreaterThanOrEqual(2);
		const last = events[events.length - 1];
		expect(last.type).toBe("error");
		expect(typeof last.error).toBe("string");
		expect(typeof last.durationMs).toBe("number");
	});

	test("captures request body even when supplied as a string", async () => {
		const file = path.join(dir, "string-body.jsonl");
		const dispatcher = new Agent().compose(createTraceInterceptor(makeWriter(file)));

		await dispatchOnce(dispatcher, {
			origin: baseUrl,
			path: "/json",
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"value":42}',
		});
		await dispatcher.close();

		const [req] = readTrace(file);
		expect(req.body).toEqual({ kind: "json", data: { value: 42 } });
	});
});
