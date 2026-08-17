import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createClient, DraftbaseError, GraphqlError } from "./index.js";

function stubFetch(status: number, body: unknown) {
	global.fetch = (async () =>
		new Response(status === 404 ? undefined : JSON.stringify(body), {
			status,
		})) as typeof fetch;
}

test("getEntries sends bearer auth and query params", async () => {
	let capturedUrl = "";
	let capturedAuth = "";
	global.fetch = (async (url: string | URL, init?: RequestInit) => {
		capturedUrl = url.toString();
		capturedAuth = (init?.headers as Record<string, string>).Authorization;
		return new Response(JSON.stringify({ entries: [], nextCursor: null }), { status: 200 });
	}) as typeof fetch;

	const client = createClient({ apiKey: "secret", baseUrl: "https://api.example.com" });
	await client.getEntries({ contentTypeId: "abc", limit: 10 });

	assert.equal(capturedAuth, "Bearer secret");
	assert.equal(
		capturedUrl,
		"https://api.example.com/delivery/entries?envId=production&contentTypeId=abc&limit=10",
	);
});

test("getEntry returns null on 404", async () => {
	stubFetch(404, undefined);
	const client = createClient({ apiKey: "secret", retries: 0 });
	assert.equal(await client.getEntry("missing"), null);
});

test("getEntries throws DraftbaseError on non-ok response", async () => {
	stubFetch(500, undefined);
	const client = createClient({ apiKey: "secret", retries: 0 });
	await assert.rejects(() => client.getEntries(), DraftbaseError);
});

test("getEntries retries on 503 then succeeds", async () => {
	let calls = 0;
	global.fetch = (async () => {
		calls++;
		if (calls === 1) return new Response(undefined, { status: 503 });
		return new Response(JSON.stringify({ entries: [], nextCursor: null }), { status: 200 });
	}) as typeof fetch;

	const client = createClient({ apiKey: "secret", retries: 1 });
	const result = await client.getEntries();

	assert.equal(calls, 2);
	assert.deepEqual(result, { entries: [], nextCursor: null });
});

test("cacheTtlMs avoids a second fetch for the same GET", async () => {
	let calls = 0;
	global.fetch = (async () => {
		calls++;
		return new Response(JSON.stringify({ entries: [], nextCursor: null }), { status: 200 });
	}) as typeof fetch;

	const client = createClient({ apiKey: "secret", cacheTtlMs: 60_000 });
	await client.getEntries();
	await client.getEntries();

	assert.equal(calls, 1);
});

test("getLocalizations requests locales=true and flattens the entry with its siblings", async () => {
	let capturedUrl = "";
	global.fetch = (async (url: string | URL) => {
		capturedUrl = url.toString();
		return new Response(
			JSON.stringify({
				_id: "en1",
				locale: "en-US",
				localizations: [{ _id: "fr1", locale: "fr-FR" }],
			}),
			{ status: 200 },
		);
	}) as typeof fetch;

	const client = createClient({ apiKey: "secret", baseUrl: "https://api.example.com" });
	const result = await client.getLocalizations("en1");

	assert.equal(
		capturedUrl,
		"https://api.example.com/delivery/entries/en1?envId=production&locales=true",
	);
	assert.deepEqual(result, [
		{ _id: "en1", locale: "en-US", localizations: [{ _id: "fr1", locale: "fr-FR" }] },
		{ _id: "fr1", locale: "fr-FR" },
	]);
});

test("entries.create POSTs body and is not retried on 503", async () => {
	let calls = 0;
	global.fetch = (async () => {
		calls++;
		return new Response(undefined, { status: 503 });
	}) as typeof fetch;

	const client = createClient({ apiKey: "secret" });
	await assert.rejects(
		() => client.entries.create({ contentTypeId: "ct1", locale: "en-US", fields: {} }),
		DraftbaseError,
	);
	assert.equal(calls, 1);
});

test("getEntries defaults envId from client `environment`, overridable per call", async () => {
	const capturedUrls: string[] = [];
	global.fetch = (async (url: string | URL) => {
		capturedUrls.push(url.toString());
		return new Response(JSON.stringify({ entries: [], nextCursor: null }), { status: 200 });
	}) as typeof fetch;

	const client = createClient({
		apiKey: "secret",
		baseUrl: "https://api.example.com",
		environment: "staging",
	});
	await client.getEntries();
	await client.getEntries({ envId: "production" });

	assert.equal(capturedUrls[0], "https://api.example.com/delivery/entries?envId=staging");
	assert.equal(capturedUrls[1], "https://api.example.com/delivery/entries?envId=production");
});

test("graphql sends query/variables and returns data", async () => {
	let capturedBody: unknown;
	global.fetch = (async (_url: string | URL, init?: RequestInit) => {
		capturedBody = JSON.parse(init!.body as string);
		return new Response(JSON.stringify({ data: { entry: { id: "1" } } }), { status: 200 });
	}) as typeof fetch;

	const client = createClient({ apiKey: "secret" });
	const data = await client.graphql<{ entry: { id: string } }>(
		"query($id: ID!) { entry(id: $id) { id } }",
		{
			id: "1",
		},
	);

	assert.deepEqual(capturedBody, {
		query: "query($id: ID!) { entry(id: $id) { id } }",
		variables: { id: "1" },
	});
	assert.deepEqual(data, { entry: { id: "1" } });
});

test("graphql throws GraphqlError when the response has errors", async () => {
	global.fetch = (async () =>
		new Response(JSON.stringify({ data: null, errors: [{ message: "not found" }] }), {
			status: 200,
		})) as typeof fetch;

	const client = createClient({ apiKey: "secret" });
	await assert.rejects(() => client.graphql('{ entry(id: "x") { id } }'), GraphqlError);
});

test("cache: 'disk' persists across a fresh requester using the same directory", async () => {
	const dir = await mkdtemp(join(tmpdir(), "draftbase-sdk-cache-test-"));
	let calls = 0;
	global.fetch = (async () => {
		calls++;
		return new Response(JSON.stringify({ entries: [], nextCursor: null }), { status: 200 });
	}) as typeof fetch;

	const first = createClient({
		apiKey: "secret",
		baseUrl: "https://api.example.com",
		cache: "disk",
		diskCacheDir: dir,
		cacheTtlMs: 60_000,
	});
	await first.getEntries();

	const second = createClient({
		apiKey: "secret",
		baseUrl: "https://api.example.com",
		cache: "disk",
		diskCacheDir: dir,
		cacheTtlMs: 60_000,
	});
	await second.getEntries();

	assert.equal(calls, 1);
});
