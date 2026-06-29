/**
 * Kimchi gateway call-flow — serverless/edge edition.
 *
 * This is a self-contained port of `src/openai-service/gateway.ts` with two
 * deliberate differences so it runs on Vercel Edge / Deno Deploy:
 *
 *   1. No `node:fs` — credentials come ONLY from the environment (there is no
 *      ~/.config/kimchi/config.json on a serverless host).
 *   2. No imports from the CLI package — it depends only on the global `fetch`,
 *      which both Vercel Edge and Deno Deploy provide.
 *
 * Keep this file dependency-free so it can be copied into either platform's
 * project layout without pulling in the rest of the harness.
 */

/** Default Kimchi gateway base URL. */
export const KIMCHI_API = "https://llm.kimchi.dev"

/** Environment surface both platforms expose (process.env / Deno.env snapshot). */
export interface Env {
	/**
	 * Optional server-side Kimchi credential, used as a fallback when the client
	 * does not send a Bearer token. In the bring-your-own-key model this is
	 * usually left unset and each client supplies its own key.
	 */
	KIMCHI_API_KEY?: string
	/** Override the gateway base URL. Optional. */
	KIMCHI_LLM_ENDPOINT?: string
}

/** Strip trailing slashes and fall back to the default endpoint when empty. */
export function normalizeEndpoint(endpoint?: string): string {
	const trimmed = endpoint?.trim()
	return (trimmed && trimmed.length > 0 ? trimmed : KIMCHI_API).replace(/\/+$/, "")
}

/** OpenAI-compatible inference base, e.g. `${endpoint}/openai/v1`. */
export function openaiBaseUrl(endpoint?: string): string {
	return `${normalizeEndpoint(endpoint)}/openai/v1`
}

/** Model metadata endpoint used to populate `/v1/models`. */
export function modelsMetadataUrl(endpoint?: string): string {
	return `${normalizeEndpoint(endpoint)}/v1/models/metadata?include_in_cli=true`
}

export interface GatewayOptions {
	env: Env
	/**
	 * API key supplied by the caller — typically the client's bearer token from
	 * the incoming `Authorization` header (bring-your-own-key). Takes precedence
	 * over `env.KIMCHI_API_KEY`.
	 */
	apiKey?: string
	/** Injected fetch for tests. Defaults to the global fetch. */
	fetchImpl?: typeof globalThis.fetch
}

/**
 * Resolve the Kimchi API key. Priority: the caller-supplied key (the client's
 * bearer token) → `env.KIMCHI_API_KEY` as a server-side fallback. Returns
 * undefined when neither is present so the handler can answer 401.
 */
export function resolveApiKey(env: Env, override?: string): string | undefined {
	if (typeof override === "string" && override.length > 0) return override
	const key = env.KIMCHI_API_KEY
	return typeof key === "string" && key.length > 0 ? key : undefined
}

/** Resolve the base endpoint from env → default. */
export function resolveEndpoint(env: Env): string {
	return normalizeEndpoint(env.KIMCHI_LLM_ENDPOINT)
}

/** Shape returned by the gateway's metadata API (subset we consume). */
export interface GatewayModel {
	slug: string
	display_name?: string
	provider?: string
}

/** A single entry in an OpenAI `GET /v1/models` response. */
export interface OpenAIModel {
	id: string
	object: "model"
	created: number
	owned_by: string
}

/** Generic gateway transport/HTTP error carrying the upstream status. */
export class GatewayError extends Error {
	readonly status: number
	constructor(message: string, status = 502) {
		super(message)
		this.name = "GatewayError"
		this.status = status
	}
}

/** Raised when no API key is available or the gateway rejects it. */
export class GatewayAuthError extends GatewayError {
	constructor(message: string) {
		super(message, 401)
		this.name = "GatewayAuthError"
	}
}

const USER_AGENT = "kimchi-openai-service-edge"

/**
 * Fetch available models and map them into the OpenAI `/v1/models` list shape.
 * Throws GatewayAuthError / GatewayError so the handler can pick a status.
 */
export async function listModels(options: GatewayOptions): Promise<OpenAIModel[]> {
	const apiKey = resolveApiKey(options.env, options.apiKey)
	if (!apiKey)
		throw new GatewayAuthError("No Kimchi API key provided (send it as a Bearer token or set KIMCHI_API_KEY)")

	const fetchImpl = options.fetchImpl ?? globalThis.fetch
	const response = await fetchImpl(modelsMetadataUrl(options.env.KIMCHI_LLM_ENDPOINT), {
		headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT },
	})

	if (response.status === 401 || response.status === 403) {
		throw new GatewayAuthError(`Gateway rejected API key: ${response.status}`)
	}
	if (!response.ok) {
		throw new GatewayError(`Failed to list models: ${response.status} ${response.statusText}`, response.status)
	}

	const body = (await response.json()) as { models?: GatewayModel[] }
	const models = Array.isArray(body?.models) ? body.models : []
	const created = Math.floor(Date.now() / 1000)
	return models
		.filter((m) => typeof m?.slug === "string" && m.slug.length > 0)
		.map((m) => ({
			id: m.slug,
			object: "model" as const,
			created,
			owned_by: m.provider ?? "kimchi-dev",
		}))
}

/**
 * Forward an OpenAI chat-completions request to the gateway, injecting auth.
 * Returns the raw `Response` so the handler can stream the body straight
 * through (works for both SSE streaming and buffered JSON).
 */
export async function chatCompletions(
	payload: BodyInit,
	options: GatewayOptions & { signal?: AbortSignal },
): Promise<Response> {
	const apiKey = resolveApiKey(options.env, options.apiKey)
	if (!apiKey)
		throw new GatewayAuthError("No Kimchi API key provided (send it as a Bearer token or set KIMCHI_API_KEY)")

	const fetchImpl = options.fetchImpl ?? globalThis.fetch
	return fetchImpl(`${openaiBaseUrl(options.env.KIMCHI_LLM_ENDPOINT)}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
			"User-Agent": USER_AGENT,
		},
		body: payload,
		signal: options.signal,
	})
}
