/**
 * HTTP request/response tracing. Captures everything dispatched through
 * undici (which includes Node's global `fetch` after `undici.install()`).
 *
 * Activated by `--trace=FILE`. Output is JSONL with one event per line so it
 * can be processed with `jq` or similar tools.
 *
 * Event types:
 *   - {"type":"request",  id, ts, method, url, headers, body?}
 *   - {"type":"response", id, ts, status, statusText, headers, body, durationMs}
 *   - {"type":"error",    id, ts, error, status?, headers?, partialBody?, durationMs}
 *
 * Bodies are encoded as:
 *   {"kind":"json",   "data": ...}    parsed JSON
 *   {"kind":"text",   "data": "..."}  utf-8 text (non-JSON or JSON parse failed)
 *   {"kind":"binary", "base64": "...", "bytes": N}  anything else
 *   {"kind":"unsupported","description":"FormData"}  body type we can't capture
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { Dispatcher } from "undici";

type TraceWriter = (event: Record<string, unknown>) => void;

let tracePath: string | undefined;
let traceWriter: TraceWriter | undefined;
let traceStream: fs.WriteStream | undefined;
let requestCounter = 0;

export function setHttpTracePath(filePath: string | undefined): void {
	if (filePath === tracePath) return;
	if (traceStream) {
		traceStream.end();
		traceStream = undefined;
	}
	tracePath = filePath;
	traceWriter = undefined;
}

export function getHttpTracePath(): string | undefined {
	return tracePath;
}

function ensureWriter(): TraceWriter | undefined {
	if (!tracePath) return undefined;
	if (traceWriter) return traceWriter;
	const resolved = path.resolve(tracePath);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	traceStream = fs.createWriteStream(resolved, { flags: "a" });
	const stream = traceStream;
	traceWriter = (event) => {
		try {
			stream.write(`${JSON.stringify(event)}\n`);
		} catch {
			// Trace failures must never break the host request.
		}
	};
	return traceWriter;
}

function normalizeHeaders(input: unknown): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = {};
	if (input == null) return out;

	const push = (rawKey: unknown, rawValue: unknown) => {
		if (rawKey == null) return;
		const key = String(rawKey).toLowerCase();
		const value: string | string[] = Array.isArray(rawValue)
			? rawValue.map((v) => (v == null ? "" : String(v)))
			: rawValue == null
				? ""
				: String(rawValue);
		const existing = out[key];
		if (existing === undefined) {
			out[key] = value;
			return;
		}
		const existingArr = Array.isArray(existing) ? existing : [existing];
		const valueArr = Array.isArray(value) ? value : [value];
		out[key] = [...existingArr, ...valueArr];
	};

	if (Array.isArray(input)) {
		for (let i = 0; i + 1 < input.length; i += 2) push(input[i], input[i + 1]);
		return out;
	}
	if (typeof input === "object") {
		const iter = (input as { [Symbol.iterator]?: () => Iterator<[unknown, unknown]> })[Symbol.iterator];
		if (typeof iter === "function") {
			for (const entry of input as Iterable<[unknown, unknown]>) push(entry[0], entry[1]);
			return out;
		}
		for (const [k, v] of Object.entries(input as Record<string, unknown>)) push(k, v);
	}
	return out;
}

function pickHeader(headers: Record<string, string | string[]>, key: string): string | undefined {
	const value = headers[key.toLowerCase()];
	if (value === undefined) return undefined;
	return Array.isArray(value) ? value[0] : value;
}

function buildUrl(options: { origin?: string | URL; path?: string }): string {
	const origin =
		options.origin == null ? "" : typeof options.origin === "string" ? options.origin : options.origin.toString();
	return origin.replace(/\/+$/, "") + (options.path ?? "");
}

type BodyEvent =
	| { kind: "json"; data: unknown }
	| { kind: "text"; data: string }
	| { kind: "binary"; base64: string; bytes: number }
	| { kind: "unsupported"; description: string };

function encodeBody(buf: Buffer, contentType: string | undefined): BodyEvent {
	if (buf.length === 0) return { kind: "text", data: "" };
	const text = buf.toString("utf8");

	if (contentType && /\bjson\b|\+json/i.test(contentType)) {
		try {
			return { kind: "json", data: JSON.parse(text) };
		} catch {
			return { kind: "text", data: text };
		}
	}

	const trimmed = text.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return { kind: "json", data: JSON.parse(text) };
		} catch {
			// Not JSON; fall through to text/binary detection.
		}
	}

	// Treat as text if valid utf-8 with no embedded NULs; otherwise binary.
	if (!buf.includes(0) && Buffer.byteLength(text, "utf8") === buf.length) {
		return { kind: "text", data: text };
	}
	return { kind: "binary", base64: buf.toString("base64"), bytes: buf.length };
}

interface CaptureResult {
	newBody: Dispatcher.DispatchOptions["body"];
	immediate?: Buffer;
	deferred?: Promise<Buffer | null>;
	unsupported?: string;
}

function captureBody(body: Dispatcher.DispatchOptions["body"]): CaptureResult {
	if (body == null) return { newBody: body };
	if (typeof body === "string") return { newBody: body, immediate: Buffer.from(body, "utf8") };
	if (Buffer.isBuffer(body)) return { newBody: body, immediate: body };
	if (body instanceof Uint8Array) return { newBody: body, immediate: Buffer.from(body) };
	if (body instanceof Readable) {
		const chunks: Buffer[] = [];
		const passThrough = new PassThrough();
		const deferred = new Promise<Buffer | null>((resolve) => {
			passThrough.on("data", (chunk: unknown) => {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
			});
			passThrough.on("end", () => resolve(Buffer.concat(chunks)));
			passThrough.on("error", () => resolve(chunks.length > 0 ? Buffer.concat(chunks) : null));
		});
		body.pipe(passThrough);
		return { newBody: passThrough as unknown as Readable, deferred };
	}
	const description = (body as { constructor?: { name?: string } }).constructor?.name ?? typeof body;
	return { newBody: body, unsupported: description };
}

export function createTraceInterceptor(writer: TraceWriter): Dispatcher.DispatcherComposeInterceptor {
	return (dispatch) => (options, handler) => {
		const id = ++requestCounter;
		const startedAt = Date.now();
		const reqHeaders = normalizeHeaders(options.headers);
		const url = buildUrl(options);
		const reqContentType = pickHeader(reqHeaders, "content-type");

		const capture = captureBody(options.body);

		const emitRequest = (bodyBuf: Buffer | null) => {
			const event: Record<string, unknown> = {
				type: "request",
				id,
				ts: new Date(startedAt).toISOString(),
				method: options.method,
				url,
				headers: reqHeaders,
			};
			if (bodyBuf) {
				event.body = encodeBody(bodyBuf, reqContentType);
			} else if (capture.unsupported) {
				event.body = { kind: "unsupported", description: capture.unsupported };
			}
			writer(event);
		};

		if (capture.immediate) {
			emitRequest(capture.immediate);
		} else if (capture.deferred) {
			capture.deferred.then(emitRequest, () => emitRequest(null));
		} else {
			emitRequest(null);
		}

		let resStatus = 0;
		let resHeaders: Record<string, string | string[]> = {};
		let resStatusMessage: string | undefined;
		const resChunks: Buffer[] = [];
		let finalized = false;

		const finalize = (kind: "response" | "error", error?: unknown) => {
			if (finalized) return;
			finalized = true;
			const contentType = pickHeader(resHeaders, "content-type");
			const partial = resChunks.length > 0 ? encodeBody(Buffer.concat(resChunks), contentType) : undefined;
			if (kind === "response") {
				const event: Record<string, unknown> = {
					type: "response",
					id,
					ts: new Date().toISOString(),
					status: resStatus,
					headers: resHeaders,
					durationMs: Date.now() - startedAt,
				};
				if (resStatusMessage !== undefined) event.statusText = resStatusMessage;
				if (partial) event.body = partial;
				else event.body = { kind: "text", data: "" };
				writer(event);
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			const event: Record<string, unknown> = {
				type: "error",
				id,
				ts: new Date().toISOString(),
				error: message,
				durationMs: Date.now() - startedAt,
			};
			if (resStatus) event.status = resStatus;
			if (Object.keys(resHeaders).length > 0) event.headers = resHeaders;
			if (partial) event.partialBody = partial;
			writer(event);
		};

		const wrappedHandler: Dispatcher.DispatchHandler = {
			onRequestStart: handler.onRequestStart?.bind(handler),
			onRequestUpgrade: handler.onRequestUpgrade?.bind(handler),
			onBodySent: handler.onBodySent?.bind(handler),
			onRequestSent: handler.onRequestSent?.bind(handler),
			onResponseStarted: handler.onResponseStarted?.bind(handler),
			onResponseStart: (controller, statusCode, hdrs, statusMessage) => {
				resStatus = statusCode;
				resStatusMessage = statusMessage;
				resHeaders = normalizeHeaders(hdrs);
				return handler.onResponseStart?.(controller, statusCode, hdrs, statusMessage);
			},
			onResponseData: (controller, chunk) => {
				resChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				return handler.onResponseData?.(controller, chunk);
			},
			onResponseEnd: (controller, trailers) => {
				finalize("response");
				return handler.onResponseEnd?.(controller, trailers);
			},
			onResponseError: (controller, error) => {
				finalize("error", error);
				return handler.onResponseError?.(controller, error);
			},
		};

		return dispatch({ ...options, body: capture.newBody }, wrappedHandler);
	};
}

/**
 * Wraps `dispatcher` with the trace interceptor when a trace path is active.
 * Returns the dispatcher unchanged otherwise.
 */
export function maybeComposeTraceInterceptor<T extends Dispatcher>(dispatcher: T): T {
	if (!tracePath) return dispatcher;
	const writer = ensureWriter();
	if (!writer) return dispatcher;
	return dispatcher.compose(createTraceInterceptor(writer)) as T;
}
