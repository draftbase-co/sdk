export type EntryStatus = "draft" | "published" | "updated" | "archived";

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
}

export interface Entry<Fields = Record<string, unknown>> {
	_id: string;
	envId: string;
	contentTypeId: string;
	locale: string;
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
	contentTypeId?: string;
	locale?: string;
	after?: string;
	limit?: number;
	envId?: Environment;
	/** Depth (0-5) to resolve `reference`/`media` fields into nested objects instead of raw ids. */
	include?: number;
	/** Relevance-ranked keyword search across text/richText fields. */
	search?: string;
	/** "semantic" embeds `search` and matches by meaning instead of keywords. No cursor pagination in this mode — `after` is ignored. */
	mode?: "text" | "semantic";
}

export interface GetEntriesResult<Fields = Record<string, unknown>> {
	entries: Entry<Fields>[];
	nextCursor: string | null;
}

export interface ListEntriesOptions extends Record<string, string | number | boolean | undefined> {
	contentTypeId?: string;
	locale?: string;
	status?: EntryStatus;
	envId?: Environment;
	include?: number;
	search?: string;
	mode?: "text" | "semantic";
}

export interface GraphqlResponse<T> {
	data: T | null;
	errors?: { message: string }[];
}

export interface CreateEntryInput {
	contentTypeId: string;
	locale: string;
	fields: Record<string, unknown>;
	envId?: Environment;
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
	s3Key: string;
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
	s3Key: string;
}

export interface ConfirmUploadInput {
	s3Key: string;
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
	contentTypeId?: string;
	includeContent?: boolean;
	createdAt: string;
}

export interface CreateWebhookInput {
	url: string;
	events: WebhookEvent[];
	envId?: Environment;
	contentTypeId?: string;
	includeContent?: boolean;
}
