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

/** React Native/browser: no writable, persistent filesystem across processes — falls back to memory. */
export function createDiskCache(_dir?: string): CacheStore {
	console.warn(
		"@draftbase/sdk: disk cache isn't supported on React Native/browser — falling back to memory cache.",
	);
	return createMemoryCache();
}
