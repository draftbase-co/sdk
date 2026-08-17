#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { createClient } from "./index.js";
import { generateContentTypeTypes } from "./codegen.js";
import { login, logout, resolveCredentials } from "./cliAuth.js";
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

async function runLogin(args: Record<string, string>) {
	await login(args["base-url"] ?? process.env.DRAFTBASE_BASE_URL ?? "https://api.draftbase.co");
}

async function runTypes(args: Record<string, string>) {
	const creds = await resolveCredentials(args);
	const baseUrl = args["base-url"] ?? process.env.DRAFTBASE_BASE_URL ?? creds.baseUrl;
	const environment = args.environment ?? process.env.DRAFTBASE_ENVIRONMENT;
	const out = args.out ?? "draftbase-types.d.ts";

	const client = createClient({
		apiKey: creds.apiKey,
		orgId: creds.orgId,
		...(baseUrl ? { baseUrl } : {}),
		...(environment ? { environment } : {}),
	});
	const contentTypes = await client.contentTypes.list();
	await writeFile(out, generateContentTypeTypes(contentTypes));
	console.log(
		`Wrote ${contentTypes.length} content type(s) from "${environment ?? "production"}" to ${out}`,
	);
}

const MIGRATION_SOURCES: Record<
	string,
	(args: Record<string, string>) => Promise<MigrationSource>
> = {
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

async function runMigrate(args: Record<string, string>) {
	const source = args.source;
	if (!source || !MIGRATION_SOURCES[source]) {
		throw new Error(
			`--source is required and must be one of: ${Object.keys(MIGRATION_SOURCES).join(", ")}`,
		);
	}

	const creds = await resolveCredentials(args);
	const baseUrl = args["base-url"] ?? process.env.DRAFTBASE_BASE_URL ?? creds.baseUrl;
	const checkpointFile = args.checkpoint ?? "draftbase-migration.checkpoint.json";
	const dryRun = args["dry-run"] === "true";

	const client = createClient({
		apiKey: creds.apiKey,
		orgId: creds.orgId,
		...(baseUrl ? { baseUrl } : {}),
		...(args.environment ? { environment: args.environment } : {}),
	});

	const migrationSource = await MIGRATION_SOURCES[source](args);

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
	if (report.errors.length > 0) process.exitCode = 1;
}

const COMMANDS: Record<string, (args: Record<string, string>) => Promise<void>> = {
	login: runLogin,
	logout: async () => logout(),
	types: runTypes,
	migrate: runMigrate,
};

async function main() {
	const [command, ...rest] = process.argv.slice(2);
	const handler = command && COMMANDS[command];
	if (!handler) {
		console.error(`Usage: draftbase <${Object.keys(COMMANDS).join("|")}> [options]`);
		process.exit(1);
	}
	await handler(parseArgs(rest));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
