import assert from "node:assert/strict";
import { test } from "node:test";
import { getNativeClipboard, getNativePlatformHelper } from "../src/native-platform.ts";

// Opt in on a Windows test desktop: this replaces the system clipboard contents.
test(
	"writes Windows clipboard text through the native helper without command fallbacks",
	{ skip: process.platform !== "win32" || process.env.PI_TEST_NATIVE_CLIPBOARD !== "1" },
	async () => {
		const clipboard = getNativeClipboard();
		assert.ok(clipboard?.setText);
		for (const text of ["clipboard café 日本語", "", "second write"]) {
			await clipboard.setText!(text);
			assert.equal(await clipboard.getText(), text);
			assert.equal(await clipboard.getImage(), null);
		}
	},
);

test(
	"uses the native platform helper directly as the clipboard API",
	{ skip: !["darwin", "win32"].includes(process.platform) || !["arm64", "x64"].includes(process.arch) },
	() => {
		const clipboard = getNativeClipboard();
		assert.ok(clipboard);
		assert.equal(typeof clipboard.getText, "function");
		assert.equal(typeof clipboard.getImage, "function");
		assert.equal(clipboard, getNativePlatformHelper());
	},
);

test("never offers a clipboard helper on Linux, with or without a display", () => {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	const saved = {
		DISPLAY: process.env.DISPLAY,
		WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
	};
	try {
		Object.defineProperty(process, "platform", { value: "linux" });
		for (const env of [
			{},
			{ DISPLAY: ":0" },
			{ WAYLAND_DISPLAY: "wayland-0" },
			{ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" },
		]) {
			if (saved.DISPLAY === undefined) delete process.env.DISPLAY;
			else process.env.DISPLAY = saved.DISPLAY;
			if (saved.WAYLAND_DISPLAY === undefined) delete process.env.WAYLAND_DISPLAY;
			else process.env.WAYLAND_DISPLAY = saved.WAYLAND_DISPLAY;
			Object.assign(process.env, env);
			assert.equal(getNativeClipboard(), undefined, JSON.stringify(env));
		}
	} finally {
		Object.defineProperty(process, "platform", platformDescriptor);
		if (saved.DISPLAY === undefined) delete process.env.DISPLAY;
		else process.env.DISPLAY = saved.DISPLAY;
		if (saved.WAYLAND_DISPLAY === undefined) delete process.env.WAYLAND_DISPLAY;
		else process.env.WAYLAND_DISPLAY = saved.WAYLAND_DISPLAY;
	}
});
