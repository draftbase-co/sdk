import { readFile } from "node:fs/promises";
import type { ContentTypeField, ContentTypeFieldType } from "../../types.js";
import { refToken } from "../types.js";
import type {
	MigrationAsset,
	MigrationContentType,
	MigrationEntry,
	MigrationFieldValue,
	MigrationSource,
} from "../types.js";

interface ContentfulField {
	id: string;
	name: string;
	type: string;
	required?: boolean;
	localized?: boolean;
	/** Hidden from the delivery API — skipped, since Draftbase has no equivalent toggle. */
	omitted?: boolean;
	linkType?: string;
	items?: { type: string; linkType?: string };
}

interface ContentfulContentType {
	sys: { id: string };
	name: string;
	fields: ContentfulField[];
}

interface ContentfulLink {
	sys: { type: "Link"; linkType: "Entry" | "Asset"; id: string };
}

interface ContentfulEntry {
	sys: { id: string; contentType: { sys: { id: string } } };
	fields: Record<string, Record<string, unknown>>;
}

interface ContentfulAsset {
	sys: { id: string };
	fields: {
		title?: Record<string, string>;
		file?: Record<string, { url: string; fileName: string; contentType: string }>;
	};
}

interface ContentfulExport {
	contentTypes: ContentfulContentType[];
	entries: ContentfulEntry[];
	assets: ContentfulAsset[];
	locales?: { code: string; default?: boolean }[];
}

const FIELD_TYPE_MAP: Record<string, ContentTypeFieldType> = {
	Symbol: "text",
	Text: "text",
	RichText: "richText",
	Integer: "number",
	Number: "number",
	Boolean: "boolean",
	Date: "date",
	Object: "json",
	Location: "json",
	Array: "json",
};

function mapFieldType(field: ContentfulField): ContentTypeFieldType {
	if (field.type === "Link") return field.linkType === "Asset" ? "media" : "reference";
	return FIELD_TYPE_MAP[field.type] ?? "json";
}

function isLink(value: unknown, linkType: "Entry" | "Asset"): value is ContentfulLink {
	const link = value as ContentfulLink | undefined;
	return link?.sys?.type === "Link" && link.sys.linkType === linkType;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localesForEntry(entry: ContentfulEntry): string[] {
	const locales = new Set<string>();
	for (const perLocale of Object.values(entry.fields)) {
		for (const locale of Object.keys(perLocale)) locales.add(locale);
	}
	return [...locales];
}

// --- Rich text (Contentful's node-tree document) -> MDX ------------------------------------
// Hand-rolled against Contentful's public rich text spec (stable node/mark type strings) rather
// than pulled through @contentful/rich-text-html-renderer + an HTML->MDX pipeline — that detour
// would both lose fidelity on the round trip and add a handful of runtime deps to a package that
// otherwise has none.

interface CfNode {
	nodeType: string;
	content?: CfNode[];
	value?: string;
	marks?: { type: string }[];
	data?: { uri?: string; target?: { sys?: { id?: string } } };
}

interface CfDocument extends CfNode {
	nodeType: "document";
}

function isCfDocument(value: unknown): value is CfDocument {
	return isPlainObject(value) && value.nodeType === "document" && Array.isArray(value.content);
}

interface RichTextContext {
	/** Resolves a Contentful entry id to the migration ref key for the current locale. */
	refKey: (entryId: string) => string;
	/** Resolves a Contentful asset id to its original hosted URL. */
	assetUrl: (assetId: string) => string;
}

/** Escapes characters that would otherwise be parsed as Markdown/MDX syntax or break JSX parsing
 * (a stray `<`, `{`, or `}` in CMS body copy is common and fatal to an MDX compile). */
function escapeMdxText(text: string): string {
	return text
		.replace(/\\/g, "\\\\")
		.replace(/([*_`[\]])/g, "\\$1")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\{/g, "&#123;")
		.replace(/\}/g, "&#125;");
}

function escapeUrl(url: string): string {
	return url.replace(/\)/g, "%29").replace(/ /g, "%20");
}

function renderMarks(text: string, marks: { type: string }[] = []): string {
	if (marks.some((mark) => mark.type === "code")) return `\`${text}\``;
	let out = escapeMdxText(text);
	if (marks.some((mark) => mark.type === "bold")) out = `**${out}**`;
	if (marks.some((mark) => mark.type === "italic")) out = `_${out}_`;
	if (marks.some((mark) => mark.type === "strikethrough")) out = `~~${out}~~`;
	if (marks.some((mark) => mark.type === "underline")) out = `<u>${out}</u>`;
	if (marks.some((mark) => mark.type === "superscript")) out = `<sup>${out}</sup>`;
	if (marks.some((mark) => mark.type === "subscript")) out = `<sub>${out}</sub>`;
	return out;
}

function renderInline(nodes: CfNode[], ctx: RichTextContext): string {
	return nodes.map((node) => renderInlineNode(node, ctx)).join("");
}

function renderInlineNode(node: CfNode, ctx: RichTextContext): string {
	switch (node.nodeType) {
		case "text":
			return renderMarks(node.value ?? "", node.marks);
		case "hyperlink":
			return `[${renderInline(node.content ?? [], ctx)}](${escapeUrl(node.data?.uri ?? "")})`;
		case "asset-hyperlink": {
			const assetId = node.data?.target?.sys?.id;
			const url = assetId ? ctx.assetUrl(assetId) : "";
			return `[${renderInline(node.content ?? [], ctx)}](${escapeUrl(url)})`;
		}
		case "entry-hyperlink":
		case "embedded-entry-inline": {
			const entryId = node.data?.target?.sys?.id;
			const token = entryId ? refToken(ctx.refKey(entryId)) : "";
			const label = renderInline(node.content ?? [], ctx);
			return `<EntryLink id="${token}">${label || "entry"}</EntryLink>`;
		}
		default:
			return "";
	}
}

function renderListItem(
	item: CfNode,
	ctx: RichTextContext,
	indent: number,
	marker: string,
): string {
	const pad = "  ".repeat(indent);
	const [first, ...rest] = item.content ?? [];
	const firstLine = first ? renderBlock(first, ctx, 0).trim() : "";
	const nested = rest.map((child) => renderBlock(child, ctx, indent + 1)).join("");
	return `${pad}${marker} ${firstLine}\n${nested}`;
}

function renderTable(node: CfNode, ctx: RichTextContext): string {
	const rows = (node.content ?? []).map((row) =>
		(row.content ?? []).map((cell) =>
			renderInline(cell.content?.[0]?.content ?? [], ctx).replace(/\|/g, "\\|"),
		),
	);
	if (rows.length === 0) return "";
	const [header, ...body] = rows;
	const lines = [
		`| ${header.join(" | ")} |`,
		`| ${header.map(() => "---").join(" | ")} |`,
		...body.map((row) => `| ${row.join(" | ")} |`),
	];
	return lines.join("\n");
}

function renderBlock(node: CfNode, ctx: RichTextContext, indent = 0): string {
	const pad = "  ".repeat(indent);
	switch (node.nodeType) {
		case "paragraph":
			return `${pad}${renderInline(node.content ?? [], ctx)}\n\n`;
		case "heading-1":
		case "heading-2":
		case "heading-3":
		case "heading-4":
		case "heading-5":
		case "heading-6": {
			const level = Number(node.nodeType.slice("heading-".length));
			return `${pad}${"#".repeat(level)} ${renderInline(node.content ?? [], ctx)}\n\n`;
		}
		case "blockquote":
			return (
				(node.content ?? [])
					.map((child) => renderBlock(child, ctx, 0).trimEnd())
					.join("\n")
					.split("\n")
					.map((line) => `> ${line}`)
					.join("\n") + "\n\n"
			);
		case "hr":
			return "---\n\n";
		case "unordered-list":
			return (
				(node.content ?? [])
					.map((item) => renderListItem(item, ctx, indent, "-"))
					.join("") + "\n"
			);
		case "ordered-list":
			return (
				(node.content ?? [])
					.map((item, index) => renderListItem(item, ctx, indent, `${index + 1}.`))
					.join("") + "\n"
			);
		case "table":
			return `${renderTable(node, ctx)}\n\n`;
		case "embedded-asset-block": {
			const assetId = node.data?.target?.sys?.id;
			return assetId ? `![](${escapeUrl(ctx.assetUrl(assetId))})\n\n` : "";
		}
		case "embedded-entry-block": {
			const entryId = node.data?.target?.sys?.id;
			const token = entryId ? refToken(ctx.refKey(entryId)) : "";
			return `<EntryLink id="${token}">entry</EntryLink>\n\n`;
		}
		default:
			return "";
	}
}

/** Converts a Contentful rich text document to an MDX string. Entry references become
 * `<EntryLink id="...">` (Draftbase's native in-body link, resolved by the migration engine once
 * the target entry exists); embedded/linked assets point at their original Contentful-hosted URL
 * — they aren't re-pointed at the migrated copy, since resolving that would need an extra API round
 * trip per image with no id-only endpoint to support it. */
export function contentfulRichTextToMdx(document: CfDocument, ctx: RichTextContext): string {
	return (document.content ?? [])
		.map((node) => renderBlock(node, ctx))
		.join("")
		.trim();
}

// --- Adapter ---------------------------------------------------------------------------------

/** Reads a `contentful-export` CLI JSON dump (`contentful space export`) and normalizes it into a
 * `MigrationSource`. Multi-locale entries become one Draftbase entry per locale; entry links to a
 * multi-locale target are pointed at the matching (or default) locale variant. Rich text fields are
 * converted to MDX, not carried over as Contentful's document JSON. */
export async function fromContentfulExport(filePath: string): Promise<MigrationSource> {
	const raw = JSON.parse(await readFile(filePath, "utf8")) as ContentfulExport;
	const defaultLocale = raw.locales?.find((locale) => locale.default)?.code;
	const entryLocales = new Map(
		raw.entries.map((entry) => [entry.sys.id, localesForEntry(entry)]),
	);
	const fieldDefsByContentType = new Map(
		raw.contentTypes.map((contentType) => [
			contentType.sys.id,
			new Map(contentType.fields.map((field) => [field.id, field])),
		]),
	);
	const assetUrls = new Map(
		raw.assets.map((asset) => {
			const file = Object.values(asset.fields.file ?? {})[0];
			const url = file ? (file.url.startsWith("//") ? `https:${file.url}` : file.url) : "";
			return [asset.sys.id, url];
		}),
	);

	function refKey(entryId: string, currentLocale: string): string {
		const locales = entryLocales.get(entryId) ?? [];
		if (locales.length <= 1) return entryId;
		const locale = locales.includes(currentLocale)
			? currentLocale
			: defaultLocale && locales.includes(defaultLocale)
				? defaultLocale
				: locales[0];
		return `${entryId}:${locale}`;
	}

	function mapValue(value: unknown, currentLocale: string): MigrationFieldValue {
		if (Array.isArray(value)) return value.map((item) => mapValue(item, currentLocale));
		if (isLink(value, "Entry")) return { $ref: refKey(value.sys.id, currentLocale) };
		if (isLink(value, "Asset")) return { $asset: value.sys.id };
		if (isPlainObject(value)) {
			const out: Record<string, MigrationFieldValue> = {};
			for (const [key, v] of Object.entries(value)) out[key] = mapValue(v, currentLocale);
			return out;
		}
		return value as MigrationFieldValue;
	}

	return {
		name: "contentful",
		async *assets(): AsyncIterable<MigrationAsset> {
			for (const asset of raw.assets) {
				const file = Object.values(asset.fields.file ?? {})[0];
				if (!file) continue;
				yield {
					key: asset.sys.id,
					url: assetUrls.get(asset.sys.id) ?? "",
					fileName: file.fileName,
					contentType: file.contentType,
					altText: Object.values(asset.fields.title ?? {})[0],
				};
			}
		},
		async *contentTypes(): AsyncIterable<MigrationContentType> {
			for (const contentType of raw.contentTypes) {
				const fields: ContentTypeField[] = contentType.fields
					.filter((field) => !field.omitted)
					.map((field) => ({
						key: field.id,
						label: field.name,
						type: mapFieldType(field),
						required: field.required,
						localized: field.localized,
					}));
				yield { key: contentType.sys.id, name: contentType.name, fields };
			}
		},
		async *entries(): AsyncIterable<MigrationEntry> {
			for (const entry of raw.entries) {
				const fieldDefs = fieldDefsByContentType.get(entry.sys.contentType.sys.id);
				for (const locale of entryLocales.get(entry.sys.id) ?? []) {
					const fields: Record<string, MigrationFieldValue> = {};
					for (const [fieldKey, perLocale] of Object.entries(entry.fields)) {
						if (!(locale in perLocale)) continue;
						const value = perLocale[locale];
						const isRichText = fieldDefs?.get(fieldKey)?.type === "RichText";
						fields[fieldKey] =
							isRichText && isCfDocument(value)
								? contentfulRichTextToMdx(value, {
										refKey: (entryId) => refKey(entryId, locale),
										assetUrl: (assetId) => assetUrls.get(assetId) ?? "",
									})
								: mapValue(value, locale);
					}
					yield {
						key: refKey(entry.sys.id, locale),
						contentTypeKey: entry.sys.contentType.sys.id,
						locale,
						fields,
					};
				}
			}
		},
	};
}
