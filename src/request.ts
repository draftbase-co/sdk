import { createDiskCache, createMemoryCache } from "./cacheStore.js";
import type { CacheStore } from "./types.js";

export class DraftbaseError extends Error {
	constructor(
		public status: number,
		message: string,
		/** Stable machine-readable code from the API, e.g. "NOT_FOUND". Absent on network errors. */
		public code?: string,
	) {
		super(message);
		this.name = "DraftbaseError";
	}
}

export class GraphqlError extends Error {
	constructor(public errors: { message: string }[]) {
		super(errors.map((error) => error.message).join("; "));
		this.name = "GraphqlError";
	}
}

export interface RequesterOptions {
	apiKey: string;
	baseUrl: string;
	/** Org id sent as `x-org-id`. Required when `apiKey` is an OAuth access token rather than a Draftbase API key. */
	orgId?: string;
	/** Retries for read requests on network errors or 429/5xx. Default 2. */
	retries?: number;
	/** Cache TTL in ms for read requests. 0 (default) disables caching. */
	cacheTtlMs?: number;
	/** Where to cache read responses when cacheTtlMs > 0. Default "memory". */
	cache?: "memory" | "disk";
	/** Directory for cache: "disk". Default a draftbase-sdk-cache folder under the OS temp dir. */
	diskCacheDir?: string;
}

export interface RequestOptions {
	method?: "GET" | "POST" | "PATCH" | "DELETE";
	params?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	/** Read (idempotent) request: eligible for retry and caching. Defaults to `method === "GET"`. */
	read?: boolean;
}

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

function buildUrl(baseUrl: string, path: string, params?: RequestOptions["params"]) {
	const url = new URL(path, baseUrl);
	for (const [key, value] of Object.entries(params ?? {})) {
		if (value !== undefined) url.searchParams.set(key, String(value));
	}
	return url;
}

function wait(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRequester({
	apiKey,
	baseUrl,
	orgId,
	retries = 2,
	cacheTtlMs = 0,
	cache = "memory",
	diskCacheDir,
}: RequesterOptions) {
	const store: CacheStore =
		cache === "disk" ? createDiskCache(diskCacheDir) : createMemoryCache();

	return async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
		const method = options.method ?? "GET";
		const isRead = options.read ?? method === "GET";
		const url = buildUrl(baseUrl, path, options.params);
		const cacheKey = `${method} ${url}${options.body !== undefined ? ` ${JSON.stringify(options.body)}` : ""}`;
		const cacheable = isRead && cacheTtlMs > 0;

		if (cacheable) {
			const hit = await store.get(cacheKey);
			if (hit && hit.expires > Date.now()) return hit.value as T;
		}

		const maxAttempts = isRead ? retries + 1 : 1;
		let lastError: unknown;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				const res = await fetch(url, {
					method,
					headers: {
						Authorization: `Bearer ${apiKey}`,
						...(orgId ? { "x-org-id": orgId } : {}),
						...(options.body !== undefined
							? { "Content-Type": "application/json" }
							: {}),
					},
					body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
				});

				if (res.status === 404) return null as T;

				if (!res.ok) {
					if (RETRYABLE_STATUSES.has(res.status) && attempt < maxAttempts - 1) {
						const retryAfter = Number(res.headers.get("retry-after"));
						await wait(retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 300);
						continue;
					}
					const body = await res.text();
					let code: string | undefined;
					let apiMessage: string | undefined;
					try {
						const parsed = JSON.parse(body) as {
							code?: unknown;
							error?: unknown;
							message?: unknown;
						};
						if (typeof parsed.code === "string") code = parsed.code;
						// `error` is prose on most failures, but the uncaught-error path puts the error's class
						// name there instead (e.g. "BSONError" — no spaces); prefer whichever reads like a sentence.
						const error = typeof parsed.error === "string" ? parsed.error : undefined;
						const message =
							typeof parsed.message === "string" ? parsed.message : undefined;
						apiMessage = error && error.includes(" ") ? error : (message ?? error);
					} catch {
						// Non-JSON error body (gateway HTML, empty) — status/body-text alone has to carry it.
					}
					throw new DraftbaseError(
						res.status,
						`Draftbase API error: ${method} ${url.pathname} -> ${res.status}` +
							(code ? ` (${code})` : "") +
							`: ${apiMessage ?? body}`,
						code,
					);
				}

				const value = (res.status === 204 ? undefined : await res.json()) as T;
				if (cacheable)
					await store.set(cacheKey, { expires: Date.now() + cacheTtlMs, value });
				return value;
			} catch (error) {
				lastError = error;
				if (error instanceof DraftbaseError) throw error;
				if (attempt < maxAttempts - 1) {
					await wait(2 ** attempt * 300);
					continue;
				}
			}
		}

		throw lastError;
	};
}
