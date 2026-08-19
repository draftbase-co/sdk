# @draftbase/sdk

[![npm](https://img.shields.io/npm/v/@draftbase/sdk)](https://www.npmjs.com/package/@draftbase/sdk)
[![GitHub](https://img.shields.io/badge/GitHub-sdk-181717?logo=github)](https://github.com/draftbase-co/sdk)

Official Node.js client for [Draftbase](https://draftbase.co), the MDX-based headless CMS for React developers. Zero runtime dependencies, uses global `fetch`, fully typed — use it to fetch published content, manage entries/content types/media, and sync your CMS schema into TypeScript types, from any Node.js backend or framework (Next.js, Astro, Remix, SvelteKit, Nuxt, Express, Cloudflare Workers).

## Install

```bash
pnpm add @draftbase/sdk
# or: npm install @draftbase/sdk
# or: yarn add @draftbase/sdk
```

## Setup

```ts
import { createClient } from "@draftbase/sdk";

const draftbase = createClient({ apiKey: process.env.DRAFTBASE_API_KEY! });
```

Options: `apiKey` (required), `baseUrl` (default `https://api.draftbase.co`), `environment` (default `envId` applied to delivery/entries reads, overridable per call), `retries` (read requests only, default `2`), `cacheTtlMs` (cache for read requests, default `0` = disabled), `cache` (`"memory"` default or `"disk"`), `diskCacheDir` (only for `cache: "disk"`, default an OS-temp folder).

Use a `delivery`-scoped key for the top-level `getEntries`/`getEntry`/`graphql` methods, and a `management`-scoped key for everything under `entries`, `contentTypes`, `media`, `webhooks`.

## Framework quickstarts

The client itself is framework-agnostic (plain Node.js, global `fetch`) — only the _calling convention_ changes per framework. Instantiate `createClient` once in a shared module and import it wherever you need content.

### Next.js (App Router)

```ts
// lib/draftbase.ts
import { createClient } from "@draftbase/sdk";
export const draftbase = createClient({ apiKey: process.env.DRAFTBASE_API_KEY! });
```

```tsx
// app/blog/[slug]/page.tsx
import { draftbase } from "@/lib/draftbase";

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
	const { slug } = await params;
	const entry = await draftbase.getEntry(slug);
	if (!entry) return notFound();
	return <article>{entry.fields.title}</article>;
}
```

Also works in Route Handlers (`app/api/**/route.ts`) and Server Actions — anywhere Node.js `fetch` runs server-side.

### Astro

```astro
---
// src/pages/blog/[slug].astro
import { draftbase } from "../../lib/draftbase";
const entry = await draftbase.getEntry(Astro.params.slug);
---
<h1>{entry.fields.title}</h1>
```

### Remix / React Router (framework mode)

```ts
// app/routes/blog.$slug.tsx
import { draftbase } from "~/lib/draftbase";
import { data } from "react-router";

export async function loader({ params }: Route.LoaderArgs) {
	const entry = await draftbase.getEntry(params.slug!);
	if (!entry) throw data(null, { status: 404 });
	return { entry };
}
```

### SvelteKit

```ts
// src/routes/blog/[slug]/+page.server.ts
import { draftbase } from "$lib/draftbase";
import { error } from "@sveltejs/kit";

export async function load({ params }) {
	const entry = await draftbase.getEntry(params.slug);
	if (!entry) error(404);
	return { entry };
}
```

### Nuxt

```ts
// server/api/blog/[slug].ts
import { draftbase } from "~/server/utils/draftbase";

export default defineEventHandler(async (event) => {
	const slug = getRouterParam(event, "slug");
	const entry = await draftbase.getEntry(slug!);
	if (!entry) throw createError({ statusCode: 404 });
	return entry;
});
```

### Node.js / Express (or any custom backend)

```ts
import express from "express";
import { draftbase } from "./lib/draftbase.js";

const app = express();
app.get("/blog/:slug", async (req, res) => {
	const entry = await draftbase.getEntry(req.params.slug);
	if (!entry) return res.sendStatus(404);
	res.json(entry);
});
```

All of the above use `getEntry`/`getEntries` (delivery-scoped, published-only reads) — swap in `entries.*`/`contentTypes.*`/`media.*` (management-scoped) the same way for authoring/admin UIs.

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

`getEntries`/`getEntry` responses are CDN-cached at the edge (per API key, keyed on the full query) — a cache hit is served without reaching the origin, so it doesn't count against your org's rate limit. Cache misses do.

To pull a whole catalog (every blog post for a sitemap, every entry of a content type) instead of one page, use `getAllEntries` — it follows `nextCursor` for you:

```ts
for await (const post of draftbase.getAllEntries<BlogPostFields>({ contentTypeId: "blogPost" })) {
	// one entry at a time, across as many pages as it takes
}
```

Not usable with `mode: "semantic"` (no cursor pagination there — page manually with `getEntries` instead).

Pin a client to one environment (matches each entry's `envId`, e.g. `"staging"` vs `"production"`):

```ts
const draftbase = createClient({ apiKey, environment: "staging" });
await draftbase.getEntries(); // envId=staging
await draftbase.getEntries({ envId: "production" }); // per-call override
```

## Locales

Each locale of a piece of content is its own entry, linked to its translations by `groupId`. Create the first locale normally, then pass its `_id` (or any sibling's `groupId`) as `groupId` when creating each additional locale:

```ts
const { id: enId } = await draftbase.entries.create({
	contentTypeId: "blogPost",
	locale: "en-US",
	fields: { title: "Hello" },
});

await draftbase.entries.create({
	contentTypeId: "blogPost",
	locale: "fr-FR",
	fields: { title: "Bonjour" },
	groupId: enId, // links this entry to enId's locale group
});
```

There's no separate endpoint for this — the same `getEntry`/`entries.get` you already use take a `locales` flag that attaches a `localizations` array (the entry's siblings, excluding itself) to the response:

```ts
const entry = await draftbase.getEntry(enId, undefined, undefined, true);
entry.localizations; // -> [{ _id: "...", locale: "fr-FR", ... }]
```

`getLocalizations` (published-only, delivery-scoped) and `entries.getLocalizations` (any status, management-scoped) are thin convenience wrappers over that same call, returning the entry and its siblings as one flat array — including itself:

```ts
const locales = await draftbase.getLocalizations(enId); // [enEntry, frEntry, ...], published only
const all = await draftbase.entries.getLocalizations(enId); // any status
```

An entry with no linked translations yet returns just itself (`localizations` is absent/`[]`). `locale` filters on `getEntries`/`entries.list` still work as before for listing one locale at a time — `locales`/`getLocalizations` is for pulling every locale of one specific entry, e.g. to build a language switcher.

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
await draftbase.entries.create({ contentTypeId, locale, fields, groupId }); // links as another locale of `groupId`'s entry — see Locales below
await draftbase.entries.update(id, fields); // replaces fields, bumps version, snapshots a revision
await draftbase.entries.updateStatus(id, "published"); // draft | review | published | archived
await draftbase.entries.rollback(id, version); // restore fields from a past revision
await draftbase.entries.delete(id);

await draftbase.entries.schedulePublish(id, "2026-01-01T09:00:00Z"); // ISO 8601, replaces any existing schedule
await draftbase.entries.cancelSchedule(id);
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
const { url, fields, storageKey } = await draftbase.media.getUploadUrl({
	fileName,
	contentType,
});

const form = new FormData();
for (const [key, value] of Object.entries(fields)) form.append(key, value);
form.append("file", file); // must be the last field
await fetch(url, { method: "POST", body: form }); // presigned POST — enforces the org's size limit

const { id } = await draftbase.media.confirmUpload({
	storageKey,
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

Webhook requests include a versioned event envelope and HMAC signatures. Use `entry.moved_to_review` with `includeContent: true` to trigger an external Claude skill or Python/JavaScript Review Readiness runner as an example.

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
- `cache: "memory"` (default) caches per client instance/process. `cache: "disk"` persists across processes under `diskCacheDir` (default an OS-temp folder) — Node-only, and only useful where the filesystem is writable and persistent between invocations (a long-running server or local dev, not typical serverless/edge runtimes). On React Native, `cache: "disk"` automatically falls back to memory (Metro resolves the `.native.js` build, which has no Node filesystem dependency) — no bundler config needed.

## CLI

One `draftbase` bin covers login, codegen, and migration. Install it globally to get a bare
`draftbase` command on your `PATH`:

```bash
npm install -g @draftbase/sdk
# or: pnpm add -g @draftbase/sdk / yarn global add @draftbase/sdk

draftbase login
```

No install: since the package name (`@draftbase/sdk`) differs from the bin name (`draftbase`),
plain `npx draftbase ...` won't resolve — use `npx -p @draftbase/sdk draftbase ...` instead:

```bash
npx -p @draftbase/sdk draftbase login
```

`draftbase login` opens your browser for OAuth login and stores a refreshable session under
`~/.draftbase`. Every subcommand below accepts either that session or an explicit
`--api-key <management-key>` (or `DRAFTBASE_API_KEY`).

### Content type sync (codegen)

Pull your org's content types and generate a `.d.ts` with one `interface` per content type:

```bash
draftbase types --out src/types/draftbase.d.ts
# or with an API key instead of a login session:
draftbase types --api-key <management-key> --out src/types/draftbase.d.ts
```

Re-run whenever content types change (e.g. a `predev`/CI step) to keep `Entry<BlogPostFields>` etc. in sync with the CMS schema.

## Migrating from another platform

`draftbase migrate` moves content models, locales, entries, and media (images/files) from another
CMS into Draftbase. It's resumable — progress is written to a checkpoint file after every item, so
you can stop (`Ctrl+C`) and rerun the same command to continue where it left off, with nothing
recreated twice.

```bash
# Contentful — from a `contentful space export` JSON dump
draftbase migrate --source contentful --file export.json --checkpoint ./migration.json

# WordPress — reads posts/pages straight from the live REST API
draftbase migrate --source wordpress --url https://example.com --checkpoint ./migration.json

# Preview counts without writing anything
draftbase migrate --source contentful --file export.json --checkpoint ./migration.json --dry-run
```

Entry-to-entry and entry-to-asset references are resolved automatically, even across circular
references, once every item has been created — including entry links _inside_ Contentful rich text,
which is converted to MDX (headings, marks, lists, tables, links, embeds), not carried over as raw
document JSON. Known limits: WordPress content stays as raw rendered HTML, not converted to MDX;
WordPress multilingual plugins (WPML/Polylang) aren't supported (single-locale only); embedded/linked
assets inside converted rich text keep pointing at their original Contentful-hosted URL rather than
the migrated copy.

Only Contentful and WordPress ship out of the box, both driven by the `draftbase migrate` CLI
subcommand above — migration tooling (`migrate()`, `MigrationSource`, adapters) is CLI-internal and
not exported from `@draftbase/sdk`'s main entry. To migrate from anywhere else, add a new adapter in
the SDK source (`src/migration/adapters/`) — any function returning a `MigrationSource`
(`assets()`/`contentTypes()`/`entries()`, each an async iterable) works with `migrate()` and the same
checkpoint/resume/retry behavior, no engine changes needed — and wire it into `MIGRATION_SOURCES` in
`src/cli.ts`.

## Using with Claude Code / AI coding agents

If you're an agent implementing Draftbase in a project, follow this checklist:

1. **Install**: `pnpm add @draftbase/sdk` (or `npm`/`yarn` equivalent — detect the project's package manager first).
2. **Never hardcode API keys.** Read `apiKey` from an environment variable (`DRAFTBASE_API_KEY` or similar) — add it to `.env.example` if the project has one, and confirm it's in `.gitignore`, don't commit it.
3. **Pick the right key scope**: `delivery` key for read-only published content (`getEntries`/`getEntry`/`graphql`); `management` key for anything under `entries`/`contentTypes`/`media`/`webhooks`. Ask the user which they have if unclear — a `delivery` key cannot call management methods and will 401/403.
4. **All methods are async** and return typed data directly (no `.data` wrapper) — `entries.list()` etc. — except `getEntry`/`entries.get`, which resolve to `null` on a 404 instead of throwing. Handle that `null` case explicitly.
5. **Don't wrap calls in retry loops** — reads already retry internally (see [Retries & caching](#retries--caching)); adding your own doubles the backoff.
6. **Generate types before writing content-shape code**: run `draftbase types --api-key <management-key> --out <path>` first, then import the generated interfaces as the `Entry<T>` type param — don't hand-write field interfaces that can drift from the live schema.
7. **This package has zero runtime dependencies** and works in any Node/Next.js context (route handlers, server components, scripts) — it is not usable in a browser bundle (no `apiKey` should ever ship client-side).

## FAQ

**What is Draftbase?**
Draftbase is a lightweight, MDX-based headless CMS built for React and Next.js developers. Content is authored as MDX/markdown with typed fields, then delivered via REST, GraphQL, or this SDK, and rendered with [`@draftbase/renderer`](https://www.npmjs.com/package/@draftbase/renderer) into React, Vue, or static HTML.

**How is `@draftbase/sdk` different from calling the REST API directly?**
It adds typed responses, automatic retries with backoff on transient read failures, optional response caching, cursor pagination handling, and a `draftbase types` command that generates TypeScript interfaces from your live content types — all of that would otherwise be hand-rolled `fetch` boilerplate.

**Does this work with the Next.js App Router / React Server Components?**
Yes — every method returns a plain `Promise`, so `await draftbase.getEntry(id)` works directly inside an `async` Server Component or Route Handler with no extra data-fetching library.

**Can I use this SDK in the browser?**
No — it's a server-side client. API keys are secrets and must never ship to a browser bundle; call this SDK from a server component, route handler, loader, or backend, and expose only the data you need to the client.

**How do I keep TypeScript types in sync with my CMS schema?**
Run `draftbase types --api-key <management-key> --out <path>` (see [Content type sync](#content-type-sync-codegen)) whenever content types change; it regenerates one `interface` per content type from the live schema.

## Links

- [npm](https://www.npmjs.com/package/@draftbase/sdk)
- [Source](https://github.com/draftbase-co/sdk)
- [Issues](https://github.com/draftbase-co/sdk/issues)
- [`@draftbase/renderer`](https://www.npmjs.com/package/@draftbase/renderer) — renders the MDX this SDK fetches
- [draftbase.co](https://draftbase.co) — product site
- [API reference](https://draftbase.co/docs/api-reference) — full REST API this SDK wraps
- [MCP server docs](https://draftbase.co/docs/mcp)
- [Framework support](https://draftbase.co/frameworks)
- [Docs](https://draftbase.co/docs)
- [Pricing](https://draftbase.co/pricing)
