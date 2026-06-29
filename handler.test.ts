import { describe, expect, it, vi } from "vitest"
import { type Env, handleRequest } from "./handler.ts"

const BASE = "https://proxy.example"

/** Fake Kimchi gateway fetch keyed by URL substring. */
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

const envWithKey: Env = { KIMCHI_API_KEY: "k" }

function get(path: string, init?: RequestInit): Request {
	return new Request(`${BASE}${path}`, init)
}

describe("edge handler", () => {
	it("answers /healthz without touching the gateway", async () => {
		const fetchImpl = fakeGateway({})
		const res = await handleRequest(get("/healthz"), envWithKey, fetchImpl)
		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toEqual({ status: "ok" })
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it("serves an info page at /", async () => {
		const res = await handleRequest(get("/"), envWithKey, fakeGateway({}))
		expect(res.status).toBe(200)
		await expect(res.json()).resolves.toMatchObject({ service: "kimchi-openai-service" })
	})

	it("serves GET /v1/models in OpenAI list shape", async () => {
		const fetchImpl = fakeGateway({
			models: () =>
				new Response(JSON.stringify({ models: [{ slug: "kimi-k2.7", provider: "moonshot" }] }), { status: 200 }),
		})
		const res = await handleRequest(get("/v1/models"), envWithKey, fetchImpl)
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
			get("/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "kimi-k2.7", messages: [{ role: "user", content: "hi" }] }),
			}),
			envWithKey,
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
		const res = await handleRequest(get("/v1/chat/completions", { method: "POST", body: "{}" }), envWithKey, fetchImpl)
		expect(res.headers.get("content-type")).toBe("text/event-stream")
		expect(await res.text()).toContain("[DONE]")
	})

	it("returns 401 when KIMCHI_API_KEY is missing", async () => {
		const res = await handleRequest(get("/v1/models"), {}, fakeGateway({}))
		expect(res.status).toBe(401)
	})

	it("404s unknown routes with an OpenAI-style error", async () => {
		const res = await handleRequest(get("/v1/nonsense"), envWithKey, fakeGateway({}))
		expect(res.status).toBe(404)
		await expect(res.json()).resolves.toMatchObject({ error: { type: "invalid_request_error" } })
	})

	describe("proxy token", () => {
		const guarded: Env = { KIMCHI_API_KEY: "k", KIMCHI_OPENAI_SERVICE_TOKEN: "secret" }

		it("rejects requests without the configured token", async () => {
			const res = await handleRequest(get("/v1/models"), guarded, fakeGateway({}))
			expect(res.status).toBe(401)
		})

		it("accepts requests presenting the token", async () => {
			const fetchImpl = fakeGateway({
				models: () => new Response(JSON.stringify({ models: [{ slug: "m" }] }), { status: 200 }),
			})
			const res = await handleRequest(
				get("/v1/models", { headers: { authorization: "Bearer secret" } }),
				guarded,
				fetchImpl,
			)
			expect(res.status).toBe(200)
		})

		it("still allows /healthz without the token", async () => {
			const res = await handleRequest(get("/healthz"), guarded, fakeGateway({}))
			expect(res.status).toBe(200)
		})
	})
})
