import { describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Context, Model } from "../src/types.ts";

// Mimics what the OpenAI SDK does when a gateway returns an HTML error page:
// safeJSON(body) fails, so makeMessage() pastes the raw body into the thrown
// error's message as "<status> <html>...</html>".
const HTML_BODY =
	"<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n" +
	"<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n" +
	"</body>\r\n</html>\r\n";

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const promise = Promise.resolve() as Promise<unknown> & {
						withResponse: () => Promise<unknown>;
					};
					promise.withResponse = () => Promise.reject(new Error(`502 ${HTML_BODY}`));
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const context: Context = {
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
};

describe("openai-completions HTML error summarization", () => {
	it("surfaces a clean headline+body instead of raw HTML", async () => {
		const stream = streamOpenAICompletions(model, context, { apiKey: "test" });
		for await (const _event of stream) {
			void _event;
		}
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("502 Bad Gateway: nginx");
		// The status code must survive so retry classification still matches.
		expect(result.errorMessage).toMatch(/502/);
		expect(result.errorMessage).not.toMatch(/<[/a-z]/i);
	});
});
