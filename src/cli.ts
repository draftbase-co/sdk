#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { createClient } from "./index.js";
import { generateContentTypeTypes } from "./codegen.js";

function parseArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i]?.replace(/^--/, "");
		if (key) args[key] = argv[i + 1] ?? "";
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const apiKey = args["api-key"] ?? process.env.DRAFTBASE_API_KEY;
	const baseUrl = args["base-url"] ?? process.env.DRAFTBASE_BASE_URL;
	const environment = args.environment ?? process.env.DRAFTBASE_ENVIRONMENT;
	const out = args.out ?? "draftbase-types.d.ts";

	if (!apiKey) {
		console.error("Missing API key. Pass --api-key or set DRAFTBASE_API_KEY (management-scoped).");
		process.exit(1);
	}

	const client = createClient({
		apiKey,
		...(baseUrl ? { baseUrl } : {}),
		...(environment ? { environment } : {}),
	});
	const contentTypes = await client.contentTypes.list();
	await writeFile(out, generateContentTypeTypes(contentTypes));
	console.log(
		`Wrote ${contentTypes.length} content type(s) from "${environment ?? "production"}" to ${out}`,
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
