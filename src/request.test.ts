import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRequester } from "./request.js";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

test("retries a 429 after the server's Retry-After wait instead of the default backoff", async () => {
	const waits: number[] = [];
	const realSetTimeout = globalThis.setTimeout;
	// @ts-expect-error - stub only the delay, still calls through immediately
	globalThis.setTimeout = (fn: () => void, ms: number) => {
		waits.push(ms);
		return realSetTimeout(fn, 0);
	};

	let callCount = 0;
	globalThis.fetch = (async () => {
		callCount++;
		if (callCount === 1) {
			return new Response("Rate Exceeded", {
				status: 429,
				headers: { "retry-after": "2" },
			});
		}
		return new Response(JSON.stringify({ ok: true }), { status: 200 });
	}) as typeof fetch;

	const request = createRequester({ apiKey: "k", baseUrl: "https://api.example.com" });
	const result = await request<{ ok: boolean }>("/delivery/entries");

	globalThis.setTimeout = realSetTimeout;
	assert.deepEqual(result, { ok: true });
	assert.equal(callCount, 2);
	assert.equal(waits[0], 2000);
});
