import { createRequester, GraphqlError, type RequesterOptions } from "./request.js";
import { DEFAULT_ENVIRONMENT } from "./types.js";
import type {
	Asset,
	ConfirmUploadInput,
	ContentType,
	CreateContentTypeInput,
	CreateEntryInput,
	CreateWebhookInput,
	Entry,
	EntryStatus,
	Environment,
	GetEntriesOptions,
	GetEntriesResult,
	GraphqlResponse,
	ListContentTypesOptions,
	ListEntriesOptions,
	OrgMediaSettings,
	UpdateContentTypeInput,
	UpdateOrgMediaSettingsInput,
	UploadUrlInput,
	UploadUrlResult,
	Webhook,
} from "./types.js";

export { DraftbaseError, GraphqlError } from "./request.js";
export { generateContentTypeTypes } from "./codegen.js";
export * from "./types.js";

export interface ClientOptions extends Omit<RequesterOptions, "baseUrl"> {
	apiKey: string;
	baseUrl?: string;
	/** Default `envId` applied to delivery/entries/content-types calls. Overridable per call via `envId`. Default "production". */
	environment?: Environment;
}

export function createClient({
	baseUrl = "https://api.draftbase.dev",
	environment = DEFAULT_ENVIRONMENT,
	...rest
}: ClientOptions) {
	const request = createRequester({ ...rest, baseUrl });

	return {
		/** Published content only. Use a `delivery`-scoped API key. */
		getEntries: <Fields = Record<string, unknown>>(options: GetEntriesOptions = {}) =>
			request<GetEntriesResult<Fields>>("/delivery/entries", {
				params: { envId: environment, ...options },
			}),
		getEntry: <Fields = Record<string, unknown>>(id: string, envId: Environment = environment) =>
			request<Entry<Fields> | null>(`/delivery/entries/${id}`, { params: { envId } }),

		/** Raw GraphQL over the same delivery-scoped, published-only data. */
		graphql: async <T = unknown>(query: string, variables?: Record<string, unknown>) => {
			const response = await request<GraphqlResponse<T>>("/graphql", {
				method: "POST",
				body: { query, variables },
				read: true,
			});
			if (response.errors?.length) throw new GraphqlError(response.errors);
			return response.data as T;
		},

		/** Read/write entries in any status. Use a `management`-scoped API key. */
		entries: {
			list: <Fields = Record<string, unknown>>(options: ListEntriesOptions = {}) =>
				request<Entry<Fields>[]>("/entries", { params: { envId: environment, ...options } }),
			get: <Fields = Record<string, unknown>>(id: string, envId: Environment = environment) =>
				request<Entry<Fields> | null>(`/entries/${id}`, { params: { envId } }),
			create: (input: CreateEntryInput) =>
				request<{ id: string }>("/entries", {
					method: "POST",
					body: { envId: environment, ...input },
				}),
			update: <Fields = Record<string, unknown>>(id: string, fields: Record<string, unknown>) =>
				request<Entry<Fields>>(`/entries/${id}`, { method: "PATCH", body: { fields } }),
			updateStatus: <Fields = Record<string, unknown>>(id: string, status: EntryStatus) =>
				request<Entry<Fields>>(`/entries/${id}/status`, { method: "PATCH", body: { status } }),
			rollback: <Fields = Record<string, unknown>>(id: string, version: number) =>
				request<Entry<Fields>>(`/entries/${id}/rollback/${version}`, { method: "POST" }),
			delete: (id: string) => request<{ ok: true }>(`/entries/${id}`, { method: "DELETE" }),
		},

		contentTypes: {
			list: (options: ListContentTypesOptions = {}) =>
				request<ContentType[]>("/content-types", { params: { envId: environment, ...options } }),
			get: (id: string) => request<ContentType | null>(`/content-types/${id}`),
			create: (input: CreateContentTypeInput) =>
				request<{ id: string }>("/content-types", {
					method: "POST",
					body: { envId: environment, ...input },
				}),
			update: (id: string, input: UpdateContentTypeInput) =>
				request<ContentType>(`/content-types/${id}`, { method: "PATCH", body: input }),
			delete: (id: string) => request<{ ok: true }>(`/content-types/${id}`, { method: "DELETE" }),
		},

		media: {
			getUploadUrl: (input: UploadUrlInput) =>
				request<UploadUrlResult>("/media/upload-url", {
					method: "POST",
					body: { envId: environment, ...input },
				}),
			confirmUpload: (input: ConfirmUploadInput) =>
				request<{ id: string }>("/media/confirm", {
					method: "POST",
					body: { envId: environment, ...input },
				}),
			get: (id: string) => request<Asset | null>(`/media/${id}`),
		},

		orgs: {
			getMediaSettings: () => request<OrgMediaSettings>("/orgs/media-settings"),
			updateMediaSettings: (input: UpdateOrgMediaSettingsInput) =>
				request<OrgMediaSettings>("/orgs/media-settings", { method: "PATCH", body: input }),
		},

		webhooks: {
			list: () => request<Omit<Webhook, "secret">[]>("/webhooks"),
			create: (input: CreateWebhookInput) =>
				request<{ id: string; secret: string }>("/webhooks", { method: "POST", body: input }),
			delete: (id: string) => request<{ ok: true }>(`/webhooks/${id}`, { method: "DELETE" }),
		},
	};
}

export type DraftbaseClient = ReturnType<typeof createClient>;
export type { Asset };
