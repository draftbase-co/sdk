import { loadCheckpoint, saveCheckpoint, type MigrationCheckpoint } from "./checkpoint.js";
import { DraftbaseError } from "../request.js";
import {
	REF_TOKEN_PATTERN,
	type MigrationClient,
	type MigrationEntry,
	type MigrationFieldValue,
	type MigrationReport,
	type MigrationSource,
} from "./types.js";

export interface MigrateOptions {
	/** Progress is persisted here after every item — rerun with the same file to resume. */
	checkpointFile: string;
	envId?: string;
	/** Walk the source and report counts without writing anything. Default false. */
	dryRun?: boolean;
	/** Keep going after a per-item failure instead of throwing. Default true. */
	continueOnError?: boolean;
	onProgress?: (event: string) => void;
	/** Persist the checkpoint to disk every N processed items. Default 10. */
	flushEvery?: number;
	/** Checked between items — abort to stop early with progress saved. */
	signal?: AbortSignal;
}

async function* toAsync<T>(iterable: AsyncIterable<T> | Iterable<T>): AsyncIterable<T> {
	yield* iterable;
}

function isObject(value: MigrationFieldValue): value is Record<string, MigrationFieldValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUnresolvedLinks(value: MigrationFieldValue): boolean {
	if (Array.isArray(value)) return value.some(hasUnresolvedLinks);
	if (isObject(value)) {
		if ("$ref" in value || "$asset" in value) return true;
		return Object.values(value).some(hasUnresolvedLinks);
	}
	return typeof value === "string" && value.includes("§ref:");
}

function resolveLinks(
	value: MigrationFieldValue,
	assetIds: Record<string, string>,
	entryIds: Record<string, string>,
	unresolved: string[],
): unknown {
	if (Array.isArray(value))
		return value.map((item) => resolveLinks(item, assetIds, entryIds, unresolved));
	if (isObject(value)) {
		if ("$ref" in value && typeof value.$ref === "string") {
			const id = entryIds[value.$ref];
			if (!id) unresolved.push(value.$ref);
			return id ?? null;
		}
		if ("$asset" in value && typeof value.$asset === "string") {
			const id = assetIds[value.$asset];
			if (!id) unresolved.push(value.$asset);
			return id ?? null;
		}
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value))
			out[key] = resolveLinks(v, assetIds, entryIds, unresolved);
		return out;
	}
	if (typeof value === "string" && value.includes("§ref:")) {
		return value.replace(REF_TOKEN_PATTERN, (match, key: string) => {
			const id = entryIds[key];
			if (!id) unresolved.push(key);
			return id ?? match;
		});
	}
	return value;
}

export async function migrate(
	client: MigrationClient,
	source: MigrationSource,
	options: MigrateOptions,
): Promise<MigrationReport> {
	const {
		checkpointFile,
		envId,
		dryRun = false,
		continueOnError = true,
		onProgress,
		flushEvery = 10,
		signal,
	} = options;

	const checkpoint: MigrationCheckpoint = await loadCheckpoint(checkpointFile);
	const linkedEntryKeys = new Set(checkpoint.linkedEntryKeys);
	let sinceFlush = 0;
	let stopped = false;

	async function flush(force = false) {
		if (dryRun) return;
		sinceFlush++;
		if (force || sinceFlush >= flushEvery) {
			sinceFlush = 0;
			checkpoint.linkedEntryKeys = [...linkedEntryKeys];
			await saveCheckpoint(checkpointFile, checkpoint);
		}
	}

	function checkAbort(): boolean {
		if (signal?.aborted) stopped = true;
		return stopped;
	}

	// Stage 1: assets
	for await (const asset of toAsync(source.assets())) {
		if (checkAbort()) break;
		if (checkpoint.assetIds[asset.key]) continue;
		try {
			const res = await fetch(asset.url);
			if (!res.ok) throw new Error(`download failed: ${res.status}`);
			const buffer = await res.arrayBuffer();
			if (!dryRun) {
				const upload = await client.media.getUploadUrl({
					fileName: asset.fileName,
					contentType: asset.contentType,
					envId,
				});
				const form = new FormData();
				for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
				form.append(
					"file",
					new Blob([buffer], { type: asset.contentType }),
					asset.fileName,
				);
				const uploadRes = await fetch(upload.url, { method: "POST", body: form });
				if (!uploadRes.ok) throw new Error(`upload failed: ${uploadRes.status}`);
				const confirmed = await client.media.confirmUpload({
					storageKey: upload.storageKey,
					contentType: asset.contentType,
					envId,
					altText: asset.altText,
				});
				checkpoint.assetIds[asset.key] = confirmed.id;
			}
			checkpoint.report.assets.created++;
			onProgress?.(`asset ${asset.key} migrated`);
		} catch (error) {
			checkpoint.report.assets.failed++;
			const message = error instanceof Error ? error.message : String(error);
			checkpoint.report.errors.push({ stage: "assets", key: asset.key, message });
			onProgress?.(`asset ${asset.key} failed: ${message}`);
			if (!continueOnError) {
				await flush(true);
				throw error;
			}
		}
		await flush();
	}

	// Stage 2: content types
	if (!stopped) {
		for await (const contentType of toAsync(source.contentTypes())) {
			if (checkAbort()) break;
			if (checkpoint.contentTypeIds[contentType.key]) continue;
			try {
				if (!dryRun) {
					let id: string;
					try {
						id = (
							await client.contentTypes.create({
								name: contentType.name,
								fields: contentType.fields,
								envId,
							})
						).id;
					} catch (createError) {
						// A prior run may have created it server-side before crashing client-side
						// (id never made it into the checkpoint) — reuse it instead of failing. The
						// conflicting id is deterministic (derived from `name`) and the server echoes
						// it back in the error text, so pull it from there rather than guess.
						const conflictId =
							createError instanceof DraftbaseError &&
							createError.code === "ALREADY_EXISTS"
								? /Template id "([^"]+)" already exists/.exec(
										createError.message,
									)?.[1]
								: undefined;
						if (!conflictId) throw createError;
						id = conflictId;
					}
					checkpoint.contentTypeIds[contentType.key] = id;
				}
				checkpoint.report.contentTypes.created++;
				onProgress?.(`content type "${contentType.name}" migrated`);
			} catch (error) {
				checkpoint.report.contentTypes.failed++;
				const message = error instanceof Error ? error.message : String(error);
				checkpoint.report.errors.push({
					stage: "contentTypes",
					key: contentType.key,
					message,
				});
				onProgress?.(`content type "${contentType.name}" failed: ${message}`);
				if (!continueOnError) {
					await flush(true);
					throw error;
				}
			}
			await flush();
		}
	}

	// Stage 3a: entries — create, deferring any field with an unresolved $ref/$asset
	const pendingLinks: MigrationEntry[] = [];
	if (!stopped) {
		for await (const entry of toAsync(source.entries())) {
			if (checkAbort()) break;
			if (checkpoint.entryIds[entry.key]) {
				if (!linkedEntryKeys.has(entry.key) && hasUnresolvedLinks(entry.fields))
					pendingLinks.push(entry);
				continue;
			}
			const contentTypeId = checkpoint.contentTypeIds[entry.contentTypeKey];
			if (!contentTypeId) {
				checkpoint.report.entries.failed++;
				checkpoint.report.errors.push({
					stage: "entries",
					key: entry.key,
					message: `unknown content type "${entry.contentTypeKey}"`,
				});
				await flush();
				continue;
			}
			try {
				const unresolved: string[] = [];
				const fields = resolveLinks(
					entry.fields,
					checkpoint.assetIds,
					checkpoint.entryIds,
					unresolved,
				) as Record<string, unknown>;
				if (!dryRun) {
					const created = await client.entries.create({
						templateId: contentTypeId,
						locale: entry.locale,
						fields,
						envId,
					});
					checkpoint.entryIds[entry.key] = created.id;
					if (entry.status && entry.status !== "draft") {
						await client.entries.updateStatus(
							created.id,
							entry.status,
							entry.publishedAt,
						);
					}
				}
				checkpoint.report.entries.created++;
				if (hasUnresolvedLinks(entry.fields)) pendingLinks.push(entry);
				else linkedEntryKeys.add(entry.key);
				onProgress?.(`entry ${entry.key} migrated`);
			} catch (error) {
				checkpoint.report.entries.failed++;
				const message = error instanceof Error ? error.message : String(error);
				checkpoint.report.errors.push({ stage: "entries", key: entry.key, message });
				onProgress?.(`entry ${entry.key} failed: ${message}`);
				if (!continueOnError) {
					await flush(true);
					throw error;
				}
			}
			await flush();
		}
	}

	// Stage 3b: resolve deferred references/media now that every entry/asset id is known
	for (const entry of pendingLinks) {
		if (checkAbort()) break;
		const newId = checkpoint.entryIds[entry.key];
		if (!newId) continue; // creation failed earlier — nothing to patch
		try {
			const unresolved: string[] = [];
			const fields = resolveLinks(
				entry.fields,
				checkpoint.assetIds,
				checkpoint.entryIds,
				unresolved,
			) as Record<string, unknown>;
			if (!dryRun) await client.entries.update(newId, fields);
			if (unresolved.length > 0) {
				checkpoint.report.errors.push({
					stage: "links",
					key: entry.key,
					message: `unresolved reference(s): ${unresolved.join(", ")}`,
				});
				// Leave off linkedEntryKeys — the target(s) may exist on a later resume, and this
				// entry needs another pass through resolveLinks once they do.
			} else {
				linkedEntryKeys.add(entry.key);
			}
			onProgress?.(`entry ${entry.key} links resolved`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			checkpoint.report.errors.push({ stage: "links", key: entry.key, message });
			onProgress?.(`entry ${entry.key} link resolution failed: ${message}`);
			if (!continueOnError) {
				await flush(true);
				throw error;
			}
		}
		await flush();
	}

	await flush(true);
	return checkpoint.report;
}
