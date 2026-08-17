#!/usr/bin/env node
import { createClient } from "./index.js";
import { migrate } from "./migration/engine.js";
import { fromContentfulExport } from "./migration/adapters/contentful.js";
import { fromWordPress } from "./migration/adapters/wordpress.js";
import type { MigrationSource } from "./migration/types.js";

function parseArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i += 1) {
		const raw = argv[i];
		if (!raw?.startsWith("--")) continue;
		const key = raw.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) args[key] = "true";
		else {
			args[key] = next;
			i++;
		}
	}
	return args;
}

const SOURCES: Record<string, (args: Record<string, string>) => Promise<MigrationSource>> = {
	contentful: (args) => {
		if (!args.file)
			throw new Error("--file <contentful-export.json> is required for --source contentful");
		return fromContentfulExport(args.file);
	},
	wordpress: (args) => {
		if (!args.url) throw new Error("--url <site-url> is required for --source wordpress");
		return fromWordPress({ url: args.url });
	},
};

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const source = args.source;
	if (!source || !SOURCES[source]) {
		console.error(
			`--source is required and must be one of: ${Object.keys(SOURCES).join(", ")}`,
		);
		process.exit(1);
	}

	const apiKey = args["api-key"] ?? process.env.DRAFTBASE_API_KEY;
	if (!apiKey) {
		console.error(
			"Missing API key. Pass --api-key or set DRAFTBASE_API_KEY (management-scoped).",
		);
		process.exit(1);
	}

	const checkpointFile = args.checkpoint ?? "draftbase-migration.checkpoint.json";
	const dryRun = args["dry-run"] === "true";

	const client = createClient({
		apiKey,
		...(args["base-url"] ? { baseUrl: args["base-url"] } : {}),
		...(args.environment ? { environment: args.environment } : {}),
	});

	const migrationSource = await SOURCES[source](args);

	const controller = new AbortController();
	process.on("SIGINT", () => {
		console.log(
			"\nStopping — progress is saved to the checkpoint file. Rerun the same command to resume.",
		);
		controller.abort();
	});

	console.log(
		`Migrating from ${migrationSource.name} (checkpoint: ${checkpointFile}${dryRun ? ", dry run" : ""})…`,
	);

	const report = await migrate(client, migrationSource, {
		checkpointFile,
		envId: args.environment,
		dryRun,
		signal: controller.signal,
		onProgress: (event) => console.log(`  ${event}`),
	});

	console.log(`\n${dryRun ? "Dry run" : "Migration"} complete:`);
	console.log(
		`  Assets:        ${report.assets.created} created, ${report.assets.failed} failed`,
	);
	console.log(
		`  Content types: ${report.contentTypes.created} created, ${report.contentTypes.failed} failed`,
	);
	console.log(
		`  Entries:       ${report.entries.created} created, ${report.entries.failed} failed`,
	);
	if (report.errors.length > 0) {
		console.log(`\n${report.errors.length} error(s):`);
		for (const error of report.errors)
			console.log(`  [${error.stage}] ${error.key}: ${error.message}`);
	}
	process.exit(report.errors.length > 0 ? 1 : 0);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
