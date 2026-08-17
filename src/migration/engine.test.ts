import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { migrate } from "./engine.js";
import type { MigrationClient, MigrationEntry, MigrationSource } from "./types.js";

const realFetch = globalThis.fetch;
beforeEach(() => {
	// No real network in tests — every asset download/upload gets a canned ok response.
	globalThis.fetch = (async () =>
		new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

function makeSource(): MigrationSource {
	return {
		name: "fake",
		async *assets() {
			yield {
				key: "a1",
				url: "https://example.com/a1.png",
				fileName: "a1.png",
				contentType: "image/png",
			};
		},
		async *contentTypes() {
			yield {
				key: "ct1",
				name: "Post",
				fields: [{ key: "title", label: "Title", type: "text" }],
			};
		},
		async *entries(): AsyncGenerator<MigrationEntry> {
			yield { key: "e1", contentTypeKey: "ct1", locale: "en", fields: { title: "First" } };
			yield {
				key: "e2",
				contentTypeKey: "ct1",
				locale: "en",
				fields: { title: "Second", related: { $ref: "e1" }, cover: { $asset: "a1" } },
			};
		},
	};
}

function makeClient(overrides: Partial<MigrationClient> = {}): {
	client: MigrationClient;
	updateCalls: { id: string; fields: Record<string, unknown> }[];
} {
	let nextId = 1;
	const updateCalls: { id: string; fields: Record<string, unknown> }[] = [];
	const client: MigrationClient = {
		contentTypes: { create: async () => ({ id: `ct-${nextId++}` }) },
		entries: {
			create: async () => ({ id: `entry-${nextId++}` }),
			update: async (id, fields) => {
				updateCalls.push({ id, fields });
			},
			updateStatus: async () => {},
		},
		media: {
			getUploadUrl: async () => ({
				url: "https://upload.example.com",
				fields: {},
				storageKey: "key-1",
			}),
			confirmUpload: async () => ({ id: `asset-${nextId++}` }),
		},
		...overrides,
	};
	return { client, updateCalls };
}

async function withCheckpoint(fn: (file: string) => Promise<void>) {
	const file = join(tmpdir(), `draftbase-migration-test-${Date.now()}-${Math.random()}.json`);
	try {
		await fn(file);
	} finally {
		await rm(file, { force: true });
	}
}

test("migrate resolves deferred entry/asset references after all items are created", async () => {
	await withCheckpoint(async (checkpointFile) => {
		const { client, updateCalls } = makeClient();
		const report = await migrate(client, makeSource(), { checkpointFile, flushEvery: 1 });

		assert.equal(report.assets.created, 1);
		assert.equal(report.contentTypes.created, 1);
		assert.equal(report.entries.created, 2);
		assert.equal(report.errors.length, 0);

		assert.equal(updateCalls.length, 1);
		const [update] = updateCalls;
		assert.match(update.id, /^entry-/);
		assert.match(update.fields.related as string, /^entry-/);
		assert.match(update.fields.cover as string, /^asset-/);
	});
});

test("migrate resumes from a checkpoint without recreating already-migrated items", async () => {
	await withCheckpoint(async (checkpointFile) => {
		let failEntryE2Once = true;
		const { client: flakyClient } = makeClient({
			entries: {
				create: async (input) => {
					if (input.fields.title === "Second" && failEntryE2Once) {
						failEntryE2Once = false;
						throw new Error("simulated network failure");
					}
					return { id: `entry-${input.fields.title}` };
				},
				update: async () => {},
				updateStatus: async () => {},
			},
		});

		const firstRun = await migrate(flakyClient, makeSource(), {
			checkpointFile,
			flushEvery: 1,
		});
		assert.equal(firstRun.entries.created, 1);
		assert.equal(firstRun.entries.failed, 1);

		let contentTypeCreateCalls = 0;
		let assetCreateCalls = 0;
		const { client: secondClient, updateCalls } = makeClient({
			contentTypes: {
				create: async (input) => {
					contentTypeCreateCalls++;
					return { id: `ct-${input.name}` };
				},
			},
			media: {
				getUploadUrl: async () => {
					assetCreateCalls++;
					return { url: "https://upload.example.com", fields: {}, storageKey: "key-1" };
				},
				confirmUpload: async () => ({ id: "asset-a1" }),
			},
		});

		const secondRun = await migrate(secondClient, makeSource(), {
			checkpointFile,
			flushEvery: 1,
		});

		// Nothing already in the checkpoint gets recreated.
		assert.equal(contentTypeCreateCalls, 0);
		assert.equal(assetCreateCalls, 0);
		// Report counters are cumulative across resumes: 1 (e1, first run) + 1 (e2, this run).
		assert.equal(secondRun.entries.created, 2);
		// The earlier failed attempt at e2 stays on the record even though the retry succeeded.
		assert.equal(secondRun.entries.failed, 1);
		assert.equal(updateCalls.length, 1);
	});
});
