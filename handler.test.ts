import { describe, expect, it, vi } from "vitest"
import { type Env, handleRequest } from "./handler.ts"

const BASE = "https://proxy.example"

/** Fake Kimchi gateway fetch keyed by URL substring; records the auth header. */
function fakeGateway(handlers: { models?: () => Response; chat?: (init?: RequestInit) => Response }) {
	return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const href = String(url)
		if (href.includes("/v1/models/metadata")) {
			return handlers.models?.() ?? new Response(JSON.stringify({ models: [] }), { status: 200 })
		}
		if (href.includes("/openai/v1/chat/completions")) {
			return handlers.chat?.(init) ?? new Response("{}", { status: 200 })
		}
		throw new Error(`unexpected upstream url: ${href}`)
	})
}

/** Pull the Authorization header from a recorded fetch call. */
function authHeaderOf(call: [string | URL | Request, RequestInit?]): string | undefined {
	const headers = call?.[1]?.headers as Record<string, string> | undefined
	return headers?.Authorization
}

/** A client request that supplies its own Kimchi key as a Bearer token. */
function withKey(path: string, key = "client-key", init: RequestInit = {}): Request {
	return new Request(`${BASE}${path}`, {
		...init,
		headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${key}` },
	})
}

const emptyEnv: Env = {}
const envWithFallbackKey: Env = { KIMCHI_API_KEY: "server-fallback" }

function get(path: string, init?: RequestInit): Request {
	return new Request(`${BASE}${path}`, init)
}

describe("edge handler", () => {
	it("answers /healthz without touching the gateway", async () => {
		const fetchImpl = fakeGateway({})
		const res = await handleRequest(get("/healthz"), emptyEnv, fetchImpl)
		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual({ status: "ok" })
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it("serves an info page at /", async () => {
		const res = await handleRequest(get("/"), emptyEnv, fakeGateway({}))
		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toMatchObject({ service: "kimchi-openai-service" })
	})

	it("serves GET /v1/models in OpenAI list shape", async () => {
		const fetchImpl = fakeGateway({
			models: () =>
				new Response(JSON.stringify({ models: [{ slug: "kimi-k2.7", provider: "moonshot" }] }), { status: 200 }),
		})
		const res = await handleRequest(withKey("/v1/models"), emptyEnv, fetchImpl)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { object: string; data: Array<{ id: string; owned_by: string }> }
		expect(body.object).toBe("list")
		expect(body.data[0]).toMatchObject({ id: "kimi-k2.7", owned_by: "moonshot" })
	})

	it("proxies POST /v1/chat/completions and passes the body through", async () => {
		let receivedBody = ""
		const fetchImpl = fakeGateway({
			chat: (init) => {
				receivedBody = String(init?.body ?? "")
				return new Response('{"id":"chatcmpl-1","choices":[]}', {
					status: 200,
					headers: { "content-type": "application/json" },
				})
			},
		})
		const res = await handleRequest(
			withKey("/v1/chat/completions", "client-key", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "kimi-k2.7", messages: [{ role: "user", content: "hi" }] }),
			}),
			emptyEnv,
			fetchImpl,
		)
		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toMatchObject({ id: "chatcmpl-1" })
		expect(JSON.parse(receivedBody)).toMatchObject({ model: "kimi-k2.7" })
	})

	it("preserves the gateway content-type for streaming responses", async () => {
		const fetchImpl = fakeGateway({
			chat: () =>
				new Response("data: {}\n\ndata: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		})
		const res = await handleRequest(
			withKey("/v1/chat/completions", "client-key", { method: "POST", body: "{}" }),
			emptyEnv,
			fetchImpl,
		)
		expect(res.headers.get("content-type")).toBe("text/event-stream")
		expect(await res.text()).toContain("[DONE]")
	})

	it("404s unknown routes with an OpenAI-style error", async () => {
		const res = await handleRequest(withKey("/v1/nonsense"), emptyEnv, fakeGateway({}))
		expect(res.status).toBe(404)
		await expect(res.json()).resolves.toMatchObject({ error: { type: "invalid_request_error" } })
	})

	describe("bring-your-own-key auth", () => {
		it("forwards the client's Bearer token upstream as the Kimchi key", async () => {
			const fetchImpl = fakeGateway({
				models: () => new Response(JSON.stringify({ models: [{ slug: "m" }] }), { status: 200 }),
			})
			const res = await handleRequest(withKey("/v1/models", "my-own-key"), emptyEnv, fetchImpl)
			expect(res.status).toBe(200)
			expect(authHeaderOf(fetchImpl.mock.calls[0])).toBe("Bearer my-own-key")
		})

		it("forwards the client key on chat completions too", async () => {
			const fetchImpl = fakeGateway({ chat: () => new Response("{}", { status: 200 }) })
			await handleRequest(
				withKey("/v1/chat/completions", "chat-key", { method: "POST", body: "{}" }),
				emptyEnv,
				fetchImpl,
			)
			expect(authHeaderOf(fetchImpl.mock.calls[0])).toBe("Bearer chat-key")
		})

		it("returns 401 when no Bearer token and no fallback key", async () => {
			const res = await handleRequest(get("/v1/models"), emptyEnv, fakeGateway({}))
			expect(res.status).toBe(401)
		})

		it("falls back to env KIMCHI_API_KEY when no Bearer token is sent", async () => {
			const fetchImpl = fakeGateway({
				models: () => new Response(JSON.stringify({ models: [{ slug: "m" }] }), { status: 200 }),
			})
			const res = await handleRequest(get("/v1/models"), envWithFallbackKey, fetchImpl)
			expect(res.status).toBe(200)
			expect(authHeaderOf(fetchImpl.mock.calls[0])).toBe("Bearer server-fallback")
		})

		it("prefers the client Bearer token over the env fallback", async () => {
			const fetchImpl = fakeGateway({
				models: () => new Response(JSON.stringify({ models: [{ slug: "m" }] }), { status: 200 }),
			})
			const res = await handleRequest(withKey("/v1/models", "client-wins"), envWithFallbackKey, fetchImpl)
			expect(res.status).toBe(200)
			expect(authHeaderOf(fetchImpl.mock.calls[0])).toBe("Bearer client-wins")
		})

		it("still allows /healthz without any key", async () => {
			const res = await handleRequest(get("/healthz"), emptyEnv, fakeGateway({}))
			expect(res.status).toBe(200)
		})
	})
})
