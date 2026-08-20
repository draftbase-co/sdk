export type EntryStatus = "draft" | "published" | "updated" | "archived";

export interface CacheEntry {
	expires: number;
	value: unknown;
}

export interface CacheStore {
	get(key: string): Promise<CacheEntry | undefined>;
	set(key: string, entry: CacheEntry): Promise<void>;
}

export const DEFAULT_ENVIRONMENT = "production";
export const SUGGESTED_ENVIRONMENTS = ["production", "staging", "dev"] as const;

/** Free-form — "production" | "staging" | "dev" are suggestions, any string is allowed. */
export type Environment = "production" | "staging" | "dev" | (string & {});

/** Resolved target of an `<EntryLink id="...">` found inside a `richText` field. */
export interface EntryLinkView {
	id: string;
	templateId: string;
	title: string;
	status: EntryStatus;
	/** Present when `entryLinkFields` was passed — the requested keys from the linked entry's `fields`. */
	fields?: Record<string, unknown>;
}

export interface Entry<Fields = Record<string, unknown>> {
	_id: string;
	envId: string;
	templateId: string;
	locale: string;
	/** Links this entry to its translations. Absent on an entry with no other locale yet — pass
	 * `_id` (or an existing sibling's `groupId`) as `groupId` when creating a translation. */
	groupId?: string;
	/** This entry's sibling locales (same group, excluding itself) — present only when fetched
	 * with `locales: true` on `getEntry`/`entries.get`, or via `getLocalizations`. */
	localizations?: Entry<Fields>[];
	fields: Fields;
	status: EntryStatus;
	version: number;
	createdAt: string;
	updatedAt: string;
	publishedAt?: string;
	scheduledPublishAt?: string;
	/** Present when fetched with `include` set — every `EntryLink` id found in this entry's
	 * rich text fields, resolved to its target entry's type/title/status. */
	entryLinks?: Record<string, EntryLinkView>;
}

export interface GetEntriesOptions extends Record<string, string | number | boolean | undefined> {
	templateId?: string;
	locale?: string;
	/** Mutually exclusive with `skip`. */
	after?: string;
	limit?: number;
	/** Mutually exclusive with `after`. */
	skip?: number;
	envId?: Environment;
	/** Depth (0-5) to resolve `reference`/`media` fields into nested objects instead of raw ids. */
	include?: number;
	/** Comma-separated `fields.<key>` list to pull onto each `entryLinks` target, e.g. "slug". */
	entryLinkFields?: string;
	/** Relevance-ranked keyword search across text/richText fields. */
	search?: string;
	/** "semantic" embeds `search` and matches by meaning instead of keywords. No cursor pagination in this mode — `after` is ignored. */
	mode?: "text" | "semantic";
	/** Comma-separated `fields.<key>` list to trim each entry's `fields` to. */
	select?: string;
}

/** Per-field filters go as extra keys: `{ "fields.slug": "my-post" }` (exact) or `{ "fields.tags[in]": "guide,howto" }`
 * (any match). `reference`/`media` fields filter by the linked doc's raw `_id`, not its slug or title. */

export interface GetEntriesResult<Fields = Record<string, unknown>> {
	entries: Entry<Fields>[];
	nextCursor: string | null;
}

export interface ListEntriesOptions extends Record<string, string | number | boolean | undefined> {
	templateId?: string;
	locale?: string;
	status?: EntryStatus;
	envId?: Environment;
	include?: number;
	entryLinkFields?: string;
	search?: string;
	mode?: "text" | "semantic";
}

export interface GraphqlResponse<T> {
	data: T | null;
	errors?: { message: string }[];
}

export interface CreateEntryInput {
	templateId: string;
	locale: string;
	fields: Record<string, unknown>;
	envId?: Environment;
	/** `_id` of an existing entry (any of its locales) to link this one to as another localization
	 * of the same content. Omit to create a standalone entry. */
	groupId?: string;
}

export type ContentTypeFieldType =
	"text" | "richText" | "number" | "boolean" | "date" | "media" | "reference" | "json";

export interface ContentTypeField {
	key: string;
	label: string;
	type: ContentTypeFieldType;
	required?: boolean;
	localized?: boolean;
}

export interface ContentType {
	_id: string;
	orgId: string;
	envId: string;
	name: string;
	fields: ContentTypeField[];
	createdAt: string;
	updatedAt: string;
}

export interface ListContentTypesOptions extends Record<
	string,
	string | number | boolean | undefined
> {
	envId?: Environment;
}

export interface CreateContentTypeInput {
	name: string;
	fields: ContentTypeField[];
	envId?: Environment;
}

export interface UpdateContentTypeInput {
	name?: string;
	fields?: ContentTypeField[];
}

export type AssetStatus = "pending" | "ready" | "failed";

export interface Asset {
	_id: string;
	orgId: string;
	envId: string;
	storageKey: string;
	contentType: string;
	status: AssetStatus;
	width?: number;
	height?: number;
	size?: number;
	error?: string;
	altText?: string;
	createdAt: string;
	/** Public CDN URL, or null if ASSETS_CDN_URL isn't configured on the backend. Only on `media.get`. */
	url?: string | null;
}

export interface UploadUrlInput {
	fileName: string;
	contentType: string;
	envId?: Environment;
}

/** POST `fields` + `file` as multipart form data to `url` (S3 presigned POST). */
export interface UploadUrlResult {
	url: string;
	fields: Record<string, string>;
	storageKey: string;
}

export interface ConfirmUploadInput {
	storageKey: string;
	contentType: string;
	envId?: Environment;
	altText?: string;
}

export interface OrgMediaSettings {
	enabled: boolean;
	maxWidth: number;
	maxHeight: number;
	maxUploadBytes: number;
}

export type UpdateOrgMediaSettingsInput = Partial<OrgMediaSettings>;

export type WebhookEvent =
	| "entry.created"
	| "entry.updated"
	| "entry.status_changed"
	| "entry.published"
	| "entry.unpublished"
	| "entry.archived"
	| "entry.deleted"
	| "entry.rolled_back"
	| "entry.tags_updated";

export interface Webhook {
	_id: string;
	orgId: string;
	url: string;
	events: WebhookEvent[];
	envId?: string;
	templateId?: string;
	includeContent?: boolean;
	createdAt: string;
}

export interface CreateWebhookInput {
	url: string;
	events: WebhookEvent[];
	envId?: Environment;
	templateId?: string;
	includeContent?: boolean;
}
