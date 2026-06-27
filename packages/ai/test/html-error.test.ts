import { describe, expect, it } from "vitest";
import { summarizeHtmlErrorBody } from "../src/utils/html-error.ts";

describe("summarizeHtmlErrorBody", () => {
	it("passes through non-HTML messages unchanged", () => {
		const msg = "400 `prompt too long; exceeded max context length by 100918 tokens`";
		expect(summarizeHtmlErrorBody(msg)).toBe(msg);
	});

	it("passes through plain JSON-ish error text unchanged", () => {
		const msg = '502 {"error":{"message":"Bad gateway"}}';
		expect(summarizeHtmlErrorBody(msg)).toBe(msg);
	});

	it("handles empty and non-string input defensively", () => {
		expect(summarizeHtmlErrorBody("")).toBe("");
	});

	it("extracts the h1 headline and body from an nginx 502 page", () => {
		const html =
			"<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n" +
			"<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n" +
			"</body>\r\n</html>\r\n";
		const result = summarizeHtmlErrorBody(`502 ${html}`);
		expect(result).toBe("502 Bad Gateway: nginx");
	});

	it("preserves the SDK status prefix when the headline lacks a status", () => {
		const html =
			'<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head>' +
			"<body><div><h2>Checking your browser before accessing the site.</h2>" +
			"<p>This process is automatic. Ray ID abc123.</p></div></body></html>";
		const result = summarizeHtmlErrorBody(`503 ${html}`);
		expect(result).toBe(
			"503 Just a moment...: Checking your browser before accessing the site. This process is automatic. Ray ID abc123.",
		);
	});

	it("falls back to the title when no h1 is present", () => {
		const html =
			"<html><head><title>504 Gateway Time-out</title></head>" +
			"<body>The server didn't respond in time. nginx</body></html>";
		const result = summarizeHtmlErrorBody(html);
		expect(result).toBe("504 Gateway Time-out: The server didn't respond in time. nginx");
	});

	it("decodes HTML entities and collapses whitespace in the body", () => {
		const html =
			"<html><head><title>500&nbsp;Internal Server Error</title></head>" +
			"<body><p>Something went&nbsp;wrong &amp; we&#39;re on it.</p></body></html>";
		const result = summarizeHtmlErrorBody(html);
		expect(result).toBe("500 Internal Server Error: Something went wrong & we're on it.");
	});

	it("strips nested tags inside the headline", () => {
		const html =
			"<html><head><title>Error</title></head>" +
			"<body><h1><span>503</span> Service Unavailable</h1><p>Try again later.</p></body></html>";
		const result = summarizeHtmlErrorBody(html);
		expect(result).toBe("503 Service Unavailable: Try again later.");
	});

	it("drops script and style content from the body", () => {
		const html =
			"<html><head><title>502 Bad Gateway</title><style>body{color:red}</style></head>" +
			"<body><h1>502 Bad Gateway</h1><script>alert('x')</script>nginx</body></html>";
		const result = summarizeHtmlErrorBody(html);
		expect(result).toBe("502 Bad Gateway: nginx");
	});

	it("truncates very long bodies with an ellipsis", () => {
		const long = "A".repeat(500);
		const html = `<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1>${long}</body></html>`;
		const result = summarizeHtmlErrorBody(html);
		expect(result.startsWith("502 Bad Gateway: ")).toBe(true);
		expect(result.endsWith("…")).toBe(true);
		expect(result.length).toBeLessThan(500);
	});

	it("produces a readable summary even without title/h1/body tags", () => {
		const html = "<div>Service offline for maintenance.</div>";
		const result = summarizeHtmlErrorBody(html);
		expect(result).toBe("Service offline for maintenance.");
	});
});
