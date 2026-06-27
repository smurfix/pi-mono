/**
 * When an LLM gateway or reverse proxy (nginx, Cloudflare, ALB, …) fails it
 * commonly returns an HTML error page instead of the JSON the API requested.
 * The OpenAI/Anthropic SDKs paste that body verbatim into the thrown error's
 * message, producing a wall of mangled markup in the surfaced error.
 *
 * {@link summarizeHtmlErrorBody} extracts a short, readable headline (from
 * `<title>`/`<h1>`) plus trimmed body text so the error stays legible.
 * Non-HTML input is returned unchanged. Any leading non-HTML prefix (e.g. an
 * HTTP status code prepended by the SDK) is preserved unless the extracted
 * headline already carries its own status, so downstream retry classification
 * that matches status codes (502/503/504) keeps working.
 */

const MAX_BODY_CHARS = 240;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

/** Matches the opening of the first HTML tag or doctype in a string. */
const HTML_START = /<!doctype\s+html|<\/?[a-z][^<>]{0,80}>/i;

function decodeEntities(text: string): string {
	return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ent: string) => {
		if (ent.startsWith("#")) {
			const code =
				ent[1] === "x" || ent[1] === "X" ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
			return Number.isSafeInteger(code) ? String.fromCodePoint(code) : whole;
		}
		return NAMED_ENTITIES[ent] ?? whole;
	});
}

/** Remove script/style/comment blocks and all remaining tags. */
function stripTags(html: string): string {
	return html
		.replace(/<script\b[\s\S]*?<\/script>/gi, "")
		.replace(/<style\b[\s\S]*?<\/style>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<[^>]+>/g, " ");
}

function normalize(text: string): string {
	return decodeEntities(text).replace(/\s+/g, " ").trim();
}

function firstMatch(html: string, re: RegExp): string {
	const match = html.match(re);
	return match ? normalize(stripTags(match[1])) : "";
}

function truncate(text: string): string {
	return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…` : text;
}

/**
 * If `message` contains HTML, return a compact `"headline: body"` summary.
 * Otherwise return `message` unchanged.
 */
export function summarizeHtmlErrorBody(message: string): string {
	if (typeof message !== "string" || message.length === 0) return message;

	const start = message.search(HTML_START);
	if (start === -1) return message;

	const prefix = message.slice(0, start).trim();
	const html = message.slice(start);

	const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
	const h1 = firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
	const headline = h1 || title;

	// Visible body text: prefer the <body> contents, otherwise drop <head>.
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	const bodySource = bodyMatch ? bodyMatch[1] : html.replace(/<head\b[\s\S]*?<\/head>/i, "");
	let body = normalize(stripTags(bodySource));
	if (headline && body.startsWith(headline)) {
		body = body.slice(headline.length).trim();
	}

	let summary: string;
	if (headline && body) {
		summary = `${headline}: ${truncate(body)}`;
	} else {
		const fallback = normalize(stripTags(html));
		summary = truncate(fallback);
	}
	if (!summary) return message;

	// Preserve a leading prefix (e.g. status code) unless the summary already
	// starts with a digit (meaning it carries its own status), avoiding
	// duplicates like "502 502 Bad Gateway".
	if (!prefix || /^\d/.test(summary)) return summary;
	return `${prefix} ${summary}`;
}
