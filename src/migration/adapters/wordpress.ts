import type { ContentTypeField, EntryStatus } from "../../types.js";
import type {
	MigrationAsset,
	MigrationContentType,
	MigrationEntry,
	MigrationFieldValue,
	MigrationSource,
} from "../types.js";

export interface WordPressSourceOptions {
	/** Site base URL, e.g. "https://example.com". */
	url: string;
	/** REST post-type slugs to pull. Default `["posts", "pages"]`. */
	postTypes?: string[];
	/** Items per page (WordPress caps this at 100). Default 100. */
	perPage?: number;
}

interface WPPost {
	id: number;
	slug: string;
	status: string;
	date: string;
	title: { rendered: string };
	content: { rendered: string };
	excerpt: { rendered: string };
	featured_media: number;
	type: string;
}

interface WPMedia {
	id: number;
	source_url: string;
	mime_type: string;
	slug: string;
	alt_text?: string;
}

const STATUS_MAP: Record<string, EntryStatus> = {
	publish: "published",
	draft: "draft",
	pending: "draft",
	future: "draft",
	private: "draft",
};

const POST_FIELDS: ContentTypeField[] = [
	{ key: "title", label: "Title", type: "text", required: true },
	{ key: "slug", label: "Slug", type: "text", required: true },
	{ key: "content", label: "Content", type: "richText" },
	{ key: "excerpt", label: "Excerpt", type: "text" },
	{ key: "date", label: "Date", type: "date" },
	{ key: "featuredImage", label: "Featured image", type: "media" },
];

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#039;/g, "'");
}

async function fetchAllPages<T>(url: URL, perPage: number): Promise<T[]> {
	const items: T[] = [];
	for (let page = 1; ; page++) {
		url.searchParams.set("per_page", String(perPage));
		url.searchParams.set("page", String(page));
		const res = await fetch(url);
		if (res.status === 400 && page > 1) break; // WordPress 400s once you page past the last one
		if (!res.ok) throw new Error(`WordPress API error ${res.status} for ${url.pathname}`);
		const batch = (await res.json()) as T[];
		items.push(...batch);
		const totalPages = Number(res.headers.get("X-WP-TotalPages") ?? "1");
		if (page >= totalPages || batch.length === 0) break;
	}
	return items;
}

/** Pulls posts/pages from the WordPress REST API and normalizes them into a `MigrationSource`. Single-locale
 * only (WPML/Polylang unsupported); rich text is carried through as raw rendered HTML, not converted to MDX. */
export async function fromWordPress(options: WordPressSourceOptions): Promise<MigrationSource> {
	const base = options.url.replace(/\/+$/, "");
	const postTypes = options.postTypes ?? ["posts", "pages"];
	const perPage = options.perPage ?? 100;

	let postsCache: WPPost[] | undefined;
	async function loadPosts(): Promise<WPPost[]> {
		if (!postsCache) {
			const all: WPPost[] = [];
			for (const postType of postTypes) {
				const items = await fetchAllPages<WPPost>(
					new URL(`${base}/wp-json/wp/v2/${postType}`),
					perPage,
				);
				all.push(...items.map((item) => ({ ...item, type: postType })));
			}
			postsCache = all;
		}
		return postsCache;
	}

	return {
		name: "wordpress",
		async *assets(): AsyncIterable<MigrationAsset> {
			const posts = await loadPosts();
			const mediaIds = [
				...new Set(posts.map((post) => post.featured_media).filter((id) => id > 0)),
			];
			for (const id of mediaIds) {
				const res = await fetch(`${base}/wp-json/wp/v2/media/${id}`);
				if (!res.ok) continue;
				const media = (await res.json()) as WPMedia;
				const extension = media.source_url.match(/\.\w+$/)?.[0] ?? "";
				yield {
					key: String(media.id),
					url: media.source_url,
					fileName: `${media.slug}${extension}`,
					contentType: media.mime_type,
					altText: media.alt_text,
				};
			}
		},
		async *contentTypes(): AsyncIterable<MigrationContentType> {
			for (const postType of postTypes) {
				yield {
					key: postType,
					name: postType === "pages" ? "Page" : "Post",
					fields: POST_FIELDS,
				};
			}
		},
		async *entries(): AsyncIterable<MigrationEntry> {
			for (const post of await loadPosts()) {
				const fields: Record<string, MigrationFieldValue> = {
					title: decodeHtmlEntities(post.title.rendered),
					slug: post.slug,
					content: post.content.rendered,
					excerpt: decodeHtmlEntities(post.excerpt.rendered),
					date: post.date,
				};
				if (post.featured_media)
					fields.featuredImage = { $asset: String(post.featured_media) };
				yield {
					key: String(post.id),
					contentTypeKey: post.type,
					locale: "en",
					fields,
					status: STATUS_MAP[post.status] ?? "draft",
				};
			}
		},
	};
}
