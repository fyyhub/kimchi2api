/**
 * Platform-agnostic request handler for the OpenAI-compatible Kimchi proxy.
 *
 * Built entirely on the Web `Request`/`Response` standard, so the same handler
 * runs on Vercel Edge Functions, Deno Deploy, Cloudflare Workers, Bun.serve,
 * etc. Platform entrypoints (api/, main.ts) just pass the incoming Request and
 * an env snapshot here.
 *
 * Routes:
 *   GET  /            → tiny info page
 *   GET  /healthz     → liveness probe (no upstream call)
 *   GET  /v1/models   → gateway model metadata, mapped to OpenAI list shape
 *   POST /v1/chat/completions → proxied to the gateway (streams SSE through)
 */

import { type Env, GatewayAuthError, GatewayError, chatCompletions, listModels, resolveEndpoint } from "./gateway.ts"

export type { Env }

const JSON_HEADERS = { "content-type": "application/json" } as const
/** Reject absurdly large bodies before forwarding. */
const MAX_BODY_BYTES = 25 * 1024 * 1024

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

/** OpenAI-style error envelope so SDK error handling works downstream. */
function errorResponse(status: number, message: string, type = "kimchi_gateway_error"): Response {
	return json(status, { error: { message, type, code: status } })
}

/** Extract the bearer token from the Authorization header, if present. */
function extractBearer(req: Request): string | undefined {
	const header = req.headers.get("authorization")
	if (!header) return undefined
	const match = /^Bearer\s+(.+)$/i.exec(header.trim())
	return match ? match[1].trim() : undefined
}

/**
 * Handle a single request. `fetchImpl` is injectable for tests; production
 * callers omit it and the global fetch is used.
 *
 * Auth model (bring-your-own-key): the client sends its Kimchi API key as the
 * `Authorization: Bearer <key>` header, and the proxy forwards it upstream as
 * KIMCHI_API_KEY. A server-side `env.KIMCHI_API_KEY` acts as a fallback when no
 * bearer token is provided.
 */
export async function handleRequest(req: Request, env: Env, fetchImpl?: typeof globalThis.fetch): Promise<Response> {
	const url = new URL(req.url)
	const { pathname } = url
	const method = req.method.toUpperCase()
	// The caller's bearer token is the upstream Kimchi key (BYOK).
	const apiKey = extractBearer(req)
	const options = { env, apiKey, fetchImpl }

	if (method === "GET" && pathname === "/healthz") {
		return json(200, { status: "ok" })
	}

	if (method === "GET" && pathname === "/") {
		return json(200, {
			service: "kimchi-openai-service",
			gateway: resolveEndpoint(env),
			routes: ["GET /v1/models", "POST /v1/chat/completions", "GET /healthz"],
		})
	}

	try {
		if (method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
			const models = await listModels(options)
			return json(200, { object: "list", data: models })
		}

		if (method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/chat/completions")) {
			const contentLength = Number(req.headers.get("content-length") ?? "0")
			if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
				return errorResponse(413, "Request body too large", "invalid_request_error")
			}
			const bodyText = await req.text()
			if (bodyText.length > MAX_BODY_BYTES) {
				return errorResponse(413, "Request body too large", "invalid_request_error")
			}
			const upstream = await chatCompletions(bodyText, { ...options, signal: req.signal })
			// Stream the gateway response straight through, preserving its
			// content-type (text/event-stream for stream:true, JSON otherwise).
			return new Response(upstream.body, {
				status: upstream.status,
				headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
			})
		}

		return errorResponse(404, `Unknown route: ${method} ${pathname}`, "invalid_request_error")
	} catch (error) {
		if (error instanceof GatewayAuthError) {
			return errorResponse(401, error.message, "invalid_request_error")
		}
		const status = error instanceof GatewayError ? error.status : 502
		const message = error instanceof Error ? error.message : String(error)
		return errorResponse(status, message)
	}
}
