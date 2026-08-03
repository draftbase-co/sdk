# @draftbase/sdk

Node.js / Next.js client for Draftbase. Zero dependencies, uses global `fetch`.

## Install

```bash
pnpm add @draftbase/sdk
```

## Setup

```ts
import { createClient } from "@draftbase/sdk";

const draftbase = createClient({ apiKey: process.env.DRAFTBASE_API_KEY! });
```

Options: `apiKey` (required), `baseUrl` (default `https://api.draftbase.co`), `environment` (default `envId` applied to delivery/entries reads, overridable per call), `retries` (read requests only, default `2`), `cacheTtlMs` (cache for read requests, default `0` = disabled), `cache` (`"memory"` default or `"disk"`), `diskCacheDir` (only for `cache: "disk"`, default an OS-temp folder).

Use a `delivery`-scoped key for the top-level `getEntries`/`getEntry`/`graphql` methods, and a `management`-scoped key for everything under `entries`, `contentTypes`, `media`, `webhooks`.

## Delivery — published content

```ts
const { entries, nextCursor } = await draftbase.getEntries({
	contentTypeId: "blogPost", // optional
	locale: "en-US", // optional
	limit: 25, // optional, max 100, default 25
	after: nextCursor, // optional, cursor pagination
});

const entry = await draftbase.getEntry("<entry id>"); // null if not found
```

Pin a client to one environment (matches each entry's `envId`, e.g. `"staging"` vs `"production"`):

```ts
const draftbase = createClient({ apiKey, environment: "staging" });
await draftbase.getEntries(); // envId=staging
await draftbase.getEntries({ envId: "production" }); // per-call override
```

## GraphQL

Same delivery-scoped, published-only data as `getEntries`/`getEntry`, queryable as GraphQL (`Query.entries`, `Query.entry`, matching args including `envId`):

```ts
const data = await draftbase.graphql<{ entry: { fields: { title: string } } }>(
	`query($id: ID!) { entry(id: $id) { fields } }`,
	{ id: "<entry id>" },
);
```

Throws `GraphqlError` (with an `errors` array) if the response has GraphQL errors.

## Entries (management)

```ts
await draftbase.entries.list({ contentTypeId, locale, status }); // any status, all filters optional
await draftbase.entries.get(id); // null if not found
await draftbase.entries.create({ contentTypeId, locale, fields }); // -> { id }, starts as "draft"
await draftbase.entries.update(id, fields); // replaces fields, bumps version, snapshots a revision
await draftbase.entries.updateStatus(id, "published"); // draft | review | published | archived
await draftbase.entries.rollback(id, version); // restore fields from a past revision
await draftbase.entries.delete(id);
```

## Content types (management)

```ts
await draftbase.contentTypes.list();
await draftbase.contentTypes.get(id);
await draftbase.contentTypes.create({ name, fields }); // -> { id }
await draftbase.contentTypes.update(id, { name, fields });
await draftbase.contentTypes.delete(id); // fails if entries still reference it
```

## Media (management)

Images are resized (max 1920x1920 by default, org-configurable), converted to WebP, and served off a CDN — asynchronously, right after upload. `confirmUpload` returns immediately with `status: "pending"`; poll `media.get` until it flips to `"ready"` (or `"failed"`).

```ts
const { url, fields, s3Key } = await draftbase.media.getUploadUrl({
	fileName,
	contentType,
});

const form = new FormData();
for (const [key, value] of Object.entries(fields)) form.append(key, value);
form.append("file", file); // must be the last field
await fetch(url, { method: "POST", body: form }); // S3 presigned POST — enforces the org's size limit

const { id } = await draftbase.media.confirmUpload({
	s3Key,
	contentType,
	altText,
});

const asset = await draftbase.media.get(id); // { status: "pending" | "ready" | "failed", width, height, url, ... }
```

Per-org defaults (max 1920x1920px, 5MB, WebP conversion on) — override, or read what's active:

```ts
await draftbase.orgs.getMediaSettings(); // { enabled, maxWidth, maxHeight, maxUploadBytes }
await draftbase.orgs.updateMediaSettings({
	maxWidth: 2560,
	maxUploadBytes: 10 * 1024 * 1024,
});
await draftbase.orgs.updateMediaSettings({ enabled: false }); // skip resize/convert, keep originals as-is
```

## Webhooks (management)

```ts
await draftbase.webhooks.list();
await draftbase.webhooks.create({
	url,
	events: ["entry.moved_to_review"],
	includeContent: true,
	envId: "production",
}); // -> { id, secret }
await draftbase.webhooks.delete(id);
```

Webhook requests include a versioned event envelope and HMAC signatures. Use `entry.moved_to_review` with `includeContent: true` to trigger an external Claude skill or Python/JavaScript Review Readiness runner.

## Typed fields

```ts
interface BlogPostFields {
	title: string;
	body: string;
}

const { entries } = await draftbase.getEntries<BlogPostFields>({
	contentTypeId: "blogPost",
});
entries[0].fields.title; // string
```

## Errors

Non-2xx responses (other than a 404, which resolves to `null`) throw `DraftbaseError` with `status` and `message`.

```ts
import { DraftbaseError } from "@draftbase/sdk";

try {
	await draftbase.getEntries();
} catch (err) {
	if (err instanceof DraftbaseError) console.error(err.status, err.message);
}
```

## Retries & caching

- Read requests (`getEntries`/`getEntry`/`graphql`/`entries.list`/`entries.get`/`contentTypes.list`/`contentTypes.get`) retry automatically on network errors or `429`/`502`/`503`/`504`, with exponential backoff (`300ms`, `600ms`, ...). Disable with `retries: 0`.
- Mutations (`create`/`update`/`delete`/...) are never auto-retried — they aren't idempotent.
- Set `cacheTtlMs` on `createClient` to cache read responses for that long (default `0`, disabled). Create a second client with a different `cacheTtlMs` if you need both cached and uncached reads in one process.
- `cache: "memory"` (default) caches per client instance/process. `cache: "disk"` persists across processes under `diskCacheDir` (default an OS-temp folder) — Node-only, and only useful where the filesystem is writable and persistent between invocations (a long-running server or local dev, not typical serverless/edge runtimes).

## Content type sync (codegen)

Pull your org's content types and generate a `.d.ts` with one `interface` per content type:

```bash
npx draftbase-sync --api-key <management-key> --out src/types/draftbase.d.ts
# or: DRAFTBASE_API_KEY=... npx draftbase-sync --out src/types/draftbase.d.ts
```

Re-run whenever content types change (e.g. a `predev`/CI step) to keep `Entry<BlogPostFields>` etc. in sync with the CMS schema.
