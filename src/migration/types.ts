import type { ContentTypeField, EntryStatus } from "../types.js";

/** A reference/media field value whose target hasn't been created yet — resolved by the engine
 * once all entries/assets exist, so adapters don't need to know target ids up front. */
export type MigrationFieldValue =
	| string
	| number
	| boolean
	| null
	| { $ref: string }
	| { $asset: string }
	| MigrationFieldValue[]
	| { [key: string]: MigrationFieldValue };

export interface MigrationAsset {
	/** Stable id from the source platform — referenced by entry fields via `{ $asset: key }`. */
	key: string;
	url: string;
	fileName: string;
	contentType: string;
	altText?: string;
}

export interface MigrationContentType {
	/** Stable id from the source platform — referenced by entries via `contentTypeKey`. */
	key: string;
	name: string;
	fields: ContentTypeField[];
}

/** Embed in a string field (e.g. converted rich text) to reference an entry that may not exist yet
 * — e.g. inside `<EntryLink id="...">`. Resolved to the real id by the engine once every entry has
 * been created; left in place (harmless, non-matching) if the target never resolves. */
export function refToken(key: string): string {
	return `§ref:${key}§`;
}

/** Matches tokens produced by `refToken` — capture group 1 is the source key. */
export const REF_TOKEN_PATTERN = /§ref:([^§]+)§/g;

export interface MigrationEntry {
	/** Stable id from the source platform — referenced by other entries via `{ $ref: key }`. */
	key: string;
	contentTypeKey: string;
	locale: string;
	fields: Record<string, MigrationFieldValue>;
	/** Applied after creation, via a status update. Default is whatever `entries.create` defaults to (draft). */
	status?: EntryStatus;
	/** The source system's original publish date (ISO 8601) — preserved instead of stamping the
	 * migration's run time. Only meaningful when `status` is "published" or "updated". */
	publishedAt?: string;
}

/** What an adapter for a source platform must implement. Each method returns (or yields) source
 * data already normalized into Draftbase shapes — content type field types mapped, reference/media
 * values wrapped as `$ref`/`$asset` markers. Order doesn't matter across methods; the engine always
 * runs assets, then content types, then entries. */
export interface MigrationSource {
	name: string;
	assets(): AsyncIterable<MigrationAsset> | Iterable<MigrationAsset>;
	contentTypes(): AsyncIterable<MigrationContentType> | Iterable<MigrationContentType>;
	entries(): AsyncIterable<MigrationEntry> | Iterable<MigrationEntry>;
}

/** The subset of `DraftbaseClient` the migration engine needs — kept structural (not imported from
 * `../index.js`) so a fake client can be used in tests without spinning up the full SDK. */
export interface MigrationClient {
	contentTypes: {
		create(input: {
			name: string;
			fields: ContentTypeField[];
			envId?: string;
		}): Promise<{ id: string }>;
	};
	entries: {
		create(input: {
			templateId: string;
			locale: string;
			fields: Record<string, unknown>;
			envId?: string;
		}): Promise<{ id: string }>;
		update(id: string, fields: Record<string, unknown>): Promise<unknown>;
		updateStatus(id: string, status: EntryStatus, publishedAt?: string): Promise<unknown>;
	};
	media: {
		getUploadUrl(input: {
			fileName: string;
			contentType: string;
			envId?: string;
		}): Promise<{ url: string; fields: Record<string, string>; storageKey: string }>;
		confirmUpload(input: {
			storageKey: string;
			contentType: string;
			envId?: string;
			altText?: string;
		}): Promise<{ id: string }>;
	};
}

export interface MigrationError {
	stage: "assets" | "contentTypes" | "entries" | "links";
	key: string;
	message: string;
}

export interface MigrationReport {
	assets: { created: number; failed: number };
	contentTypes: { created: number; failed: number };
	entries: { created: number; failed: number };
	errors: MigrationError[];
}
