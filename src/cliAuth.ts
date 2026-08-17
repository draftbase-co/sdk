import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { exec } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".draftbase");
const AUTH_FILE = join(CONFIG_DIR, "auth.json");
const CALLBACK_PORT = 51820;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

interface StoredAuth {
	baseUrl: string;
	clientId: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	orgId: string;
}

function decodeJwtOrgId(accessToken: string): string {
	const payload = JSON.parse(
		Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString(),
	);
	if (typeof payload.orgId !== "string") {
		throw new Error("OAuth access token is missing an org — pick an org during login.");
	}
	return payload.orgId;
}

function openBrowser(url: string) {
	const command =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "start"
				: "xdg-open";
	exec(`${command} "${url}"`);
}

async function readStoredAuth(): Promise<StoredAuth | undefined> {
	try {
		return JSON.parse(await readFile(AUTH_FILE, "utf8"));
	} catch {
		return undefined;
	}
}

async function writeStoredAuth(auth: StoredAuth) {
	await mkdir(CONFIG_DIR, { recursive: true });
	await writeFile(AUTH_FILE, JSON.stringify(auth, null, 2));
}

async function registerClient(baseUrl: string): Promise<string> {
	const res = await fetch(`${baseUrl}/oauth/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_name: "Draftbase CLI", redirect_uris: [REDIRECT_URI] }),
	});
	if (!res.ok) throw new Error(`Failed to register OAuth client: ${await res.text()}`);
	const body = (await res.json()) as { client_id: string };
	return body.client_id;
}

/** Opens the system browser for the OAuth 2.1 + PKCE authorization-code flow, catches the
 * redirect on a local loopback server, and stores the resulting tokens under ~/.draftbase. */
export async function login(baseUrl: string) {
	const existing = await readStoredAuth();
	const clientId =
		existing?.baseUrl === baseUrl ? existing.clientId : await registerClient(baseUrl);

	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const state = randomBytes(16).toString("hex");

	const code = await new Promise<string>((resolve, reject) => {
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "", REDIRECT_URI);
			if (url.pathname !== "/callback") {
				res.writeHead(404).end();
				return;
			}
			const returnedState = url.searchParams.get("state");
			const returnedCode = url.searchParams.get("code");
			const error = url.searchParams.get("error");
			res.writeHead(200, { "Content-Type": "text/html" }).end(
				error
					? "<h1>Login failed</h1>You can close this tab."
					: "<h1>Logged in</h1>You can close this tab and return to the terminal.",
			);
			server.close();
			if (error) return reject(new Error(`OAuth error: ${error}`));
			if (returnedState !== state) return reject(new Error("OAuth state mismatch"));
			if (!returnedCode) return reject(new Error("No code returned from authorize endpoint"));
			resolve(returnedCode);
		});
		server.listen(CALLBACK_PORT, "127.0.0.1", () => {
			const params = new URLSearchParams({
				response_type: "code",
				client_id: clientId,
				redirect_uri: REDIRECT_URI,
				code_challenge: challenge,
				code_challenge_method: "S256",
				state,
			});
			const authorizeUrl = `${baseUrl}/oauth/authorize?${params.toString()}`;
			console.log(`Opening ${authorizeUrl} …`);
			openBrowser(authorizeUrl);
		});
		server.on("error", reject);
	});

	const tokens = await exchangeToken(baseUrl, {
		grant_type: "authorization_code",
		code,
		redirect_uri: REDIRECT_URI,
		client_id: clientId,
		code_verifier: verifier,
	});

	await writeStoredAuth({
		baseUrl,
		clientId,
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt: Date.now() + tokens.expires_in * 1000,
		orgId: decodeJwtOrgId(tokens.access_token),
	});
	console.log("Logged in.");
}

export async function logout() {
	await rm(AUTH_FILE, { force: true });
	console.log("Logged out.");
}

async function exchangeToken(
	baseUrl: string,
	body: Record<string, string>,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
	const res = await fetch(`${baseUrl}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
	return res.json();
}

/** Resolves credentials for a CLI command: an explicit --api-key/DRAFTBASE_API_KEY wins (no
 * org header needed, keys are already org-scoped); otherwise falls back to a stored OAuth
 * session from `login`, refreshing it first if it's within a minute of expiring. */
export async function resolveCredentials(
	args: Record<string, string>,
): Promise<{ apiKey: string; orgId?: string; baseUrl?: string }> {
	const apiKey = args["api-key"] ?? process.env.DRAFTBASE_API_KEY;
	if (apiKey) return { apiKey, baseUrl: args["base-url"] };

	const auth = await readStoredAuth();
	if (!auth) {
		throw new Error(
			'Not logged in. Run "draftbase login", or pass --api-key / set DRAFTBASE_API_KEY.',
		);
	}

	if (Date.now() < auth.expiresAt - 60_000) {
		return { apiKey: auth.accessToken, orgId: auth.orgId, baseUrl: auth.baseUrl };
	}

	const tokens = await exchangeToken(auth.baseUrl, {
		grant_type: "refresh_token",
		refresh_token: auth.refreshToken,
	});
	const refreshed: StoredAuth = {
		...auth,
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt: Date.now() + tokens.expires_in * 1000,
		orgId: decodeJwtOrgId(tokens.access_token),
	};
	await writeStoredAuth(refreshed);
	return { apiKey: refreshed.accessToken, orgId: refreshed.orgId, baseUrl: refreshed.baseUrl };
}
