import assert from "node:assert/strict";
import { test } from "node:test";
import { generateContentTypeTypes } from "./codegen.js";
import type { ContentType } from "./types.js";

const blogPost: ContentType = {
	_id: "ct1",
	orgId: "org1",
	envId: "production",
	name: "Blog Post",
	fields: [
		{ key: "title", label: "Title", type: "text", required: true },
		{ key: "body", label: "Body", type: "richText" },
		{ key: "views", label: "Views", type: "number" },
	],
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

test("generates an interface per content type with required/optional fields", () => {
	const output = generateContentTypeTypes([blogPost]);

	assert.match(output, /export interface BlogPostFields \{/);
	assert.match(output, /\ttitle: string;/);
	assert.match(output, /\tbody\?: string;/);
	assert.match(output, /\tviews\?: number;/);
});

test("generates a ContentTypeFieldsMap keyed by content type id", () => {
	const output = generateContentTypeTypes([blogPost]);

	assert.match(output, /export interface ContentTypeFieldsMap \{/);
	assert.match(output, /"ct1": BlogPostFields;/);
});
