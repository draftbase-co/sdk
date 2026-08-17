import assert from "node:assert/strict";
import { test } from "node:test";
import { contentfulRichTextToMdx } from "./contentful.js";

const ctx = {
	refKey: (entryId: string) => entryId,
	assetUrl: (assetId: string) => `https://images.ctfassets.net/${assetId}.png`,
};

test("contentfulRichTextToMdx renders headings, marks, and paragraphs", () => {
	const document = {
		nodeType: "document" as const,
		content: [
			{ nodeType: "heading-2", content: [{ nodeType: "text", value: "Title", marks: [] }] },
			{
				nodeType: "paragraph",
				content: [
					{ nodeType: "text", value: "Hello ", marks: [] },
					{ nodeType: "text", value: "world", marks: [{ type: "bold" }] },
				],
			},
		],
	};

	assert.equal(contentfulRichTextToMdx(document, ctx), "## Title\n\nHello **world**");
});

test("contentfulRichTextToMdx converts entry links to an unresolved <EntryLink> token", () => {
	const document = {
		nodeType: "document" as const,
		content: [
			{
				nodeType: "paragraph",
				content: [
					{
						nodeType: "entry-hyperlink",
						data: { target: { sys: { id: "entry-123" } } },
						content: [{ nodeType: "text", value: "see this", marks: [] }],
					},
				],
			},
		],
	};

	assert.equal(
		contentfulRichTextToMdx(document, ctx),
		'<EntryLink id="§ref:entry-123§">see this</EntryLink>',
	);
});

test("contentfulRichTextToMdx converts embedded assets and lists", () => {
	const document = {
		nodeType: "document" as const,
		content: [
			{ nodeType: "embedded-asset-block", data: { target: { sys: { id: "asset-1" } } } },
			{
				nodeType: "unordered-list",
				content: [
					{
						nodeType: "list-item",
						content: [
							{
								nodeType: "paragraph",
								content: [{ nodeType: "text", value: "one", marks: [] }],
							},
						],
					},
					{
						nodeType: "list-item",
						content: [
							{
								nodeType: "paragraph",
								content: [{ nodeType: "text", value: "two", marks: [] }],
							},
						],
					},
				],
			},
		],
	};

	assert.equal(
		contentfulRichTextToMdx(document, ctx),
		"![](https://images.ctfassets.net/asset-1.png)\n\n- one\n- two",
	);
});

test("contentfulRichTextToMdx escapes characters that would break MDX parsing", () => {
	const document = {
		nodeType: "document" as const,
		content: [
			{
				nodeType: "paragraph",
				content: [{ nodeType: "text", value: "a <b> {c}", marks: [] }],
			},
		],
	};

	assert.equal(contentfulRichTextToMdx(document, ctx), "a &lt;b&gt; &#123;c&#125;");
});
