import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MigrationReport } from "./types.js";

export interface MigrationCheckpoint {
	assetIds: Record<string, string>;
	contentTypeIds: Record<string, string>;
	entryIds: Record<string, string>;
	/** Entry keys whose reference/media fields have already been resolved and patched. */
	linkedEntryKeys: string[];
	report: MigrationReport;
}

export function emptyCheckpoint(): MigrationCheckpoint {
	return {
		assetIds: {},
		contentTypeIds: {},
		entryIds: {},
		linkedEntryKeys: [],
		report: {
			assets: { created: 0, failed: 0 },
			contentTypes: { created: 0, failed: 0 },
			entries: { created: 0, failed: 0 },
			errors: [],
		},
	};
}

export async function loadCheckpoint(file: string): Promise<MigrationCheckpoint> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as MigrationCheckpoint;
	} catch {
		return emptyCheckpoint();
	}
}

export async function saveCheckpoint(file: string, checkpoint: MigrationCheckpoint): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(checkpoint, null, 2));
}
