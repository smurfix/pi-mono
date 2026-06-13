import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamSimple } from "../src/stream.ts";
import type { Context } from "../src/types.ts";

/**
 * Regression: proxies/gateways that override baseUrl may not support
 * the thinking parameter and can reject or mangle it (e.g. converting
 * adaptive to enabled). When we get a 400 about unsupported thinking,
 * the code should retry without thinking/output_config.
 */

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

/** Minimal Anthropic streaming response that completes immediately. */
function makeMinimalStreamResponse(): string {
	const msgStart = JSON.stringify({
		type: "message_start",
		message: {
			id: "msg_test",
			type: "message",
			role: "assistant",
			content: [],
			model: "claude-opus-4-8",
			stop_reason: null,
			usage: { input_tokens: 10, output_tokens: 0 },
		},
	});
	const contentStart = JSON.stringify({
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	});
	const delta = JSON.stringify({
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: "ok" },
	});
	const contentStop = JSON.stringify({ type: "content_block_stop", index: 0 });
	const msgDelta = JSON.stringify({
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: { output_tokens: 1 },
	});
	const msgStop = JSON.stringify({ type: "message_stop" });

	return [
		`event: message_start\ndata: ${msgStart}\n\n`,
		`event: content_block_start\ndata: ${contentStart}\n\n`,
		`event: content_block_delta\ndata: ${delta}\n\n`,
		`event: content_block_stop\ndata: ${contentStop}\n\n`,
		`event: message_delta\ndata: ${msgDelta}\n\n`,
		`event: message_stop\ndata: ${msgStop}\n\n`,
	].join("");
}

describe("Anthropic thinking proxy fallback", () => {
	it("retries without thinking when proxy returns 400 about thinking.type", async () => {
		const receivedBodies: Array<Record<string, unknown>> = [];

		const server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});
			req.on("end", () => {
				const parsed = JSON.parse(body);
				receivedBodies.push(parsed);

				if (parsed.thinking) {
					// First request: reject thinking
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							type: "error",
							error: {
								type: "invalid_request_error",
								message:
									'"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.',
							},
						}),
					);
				} else {
					// Retry: succeed
					res.writeHead(200, { "Content-Type": "text/event-stream" });
					res.end(makeMinimalStreamResponse());
				}
			});
		});

		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;

		try {
			const model = {
				...getModel("anthropic", "claude-opus-4-8"),
				baseUrl: `http://127.0.0.1:${port}`,
			};

			const stream = streamSimple(model, makeContext(), {
				reasoning: "high",
				apiKey: "fake-key",
			});

			const result = await stream.result();

			// Two requests: first rejected, second succeeded
			expect(receivedBodies.length).toBe(2);

			// First request should have thinking and output_config
			expect(receivedBodies[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
			expect(receivedBodies[0].output_config).toEqual({ effort: "high" });

			// Second request (retry) should NOT have thinking or output_config
			expect(receivedBodies[1].thinking).toBeUndefined();
			expect(receivedBodies[1].output_config).toBeUndefined();

			// Should succeed
			expect(result.stopReason).toBe("stop");
		} finally {
			server.close();
		}
	});

	it("does not retry on non-thinking 400 errors", async () => {
		const receivedBodies: Array<Record<string, unknown>> = [];

		const server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});
			req.on("end", () => {
				receivedBodies.push(JSON.parse(body));
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						type: "error",
						error: {
							type: "invalid_request_error",
							message: "max_tokens: must be at least 1",
						},
					}),
				);
			});
		});

		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;

		try {
			const model = {
				...getModel("anthropic", "claude-opus-4-8"),
				baseUrl: `http://127.0.0.1:${port}`,
			};

			const stream = streamSimple(model, makeContext(), {
				reasoning: "high",
				apiKey: "fake-key",
			});

			const result = await stream.result();

			// Should NOT retry - only one request
			expect(receivedBodies.length).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("max_tokens");
		} finally {
			server.close();
		}
	});
});
