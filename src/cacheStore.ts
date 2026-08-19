import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheEntry, CacheStore } from "./types.js";

export function createMemoryCache(): CacheStore {
	const map = new Map<string, CacheEntry>();
	return {
		async get(key) {
			return map.get(key);
		},
		async set(key, entry) {
			map.set(key, entry);
		},
	};
}

/** Node-only. Not for edge/serverless runtimes with an ephemeral or read-only filesystem. */
export function createDiskCache(dir: string = join(tmpdir(), "draftbase-sdk-cache")): CacheStore {
	function fileFor(key: string) {
		const hash = createHash("sha256").update(key).digest("hex");
		return join(dir, `${hash}.json`);
	}

	return {
		async get(key) {
			try {
				return JSON.parse(await readFile(fileFor(key), "utf8")) as CacheEntry;
			} catch {
				return undefined;
			}
		},
		async set(key, entry) {
			await mkdir(dir, { recursive: true });
			await writeFile(fileFor(key), JSON.stringify(entry));
		},
	};
}
