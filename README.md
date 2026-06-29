# Kimchi OpenAI-compatible proxy — serverless edition

A zero-dependency, Web-standard port of `src/openai-service/` that runs on
**Vercel Edge Functions** and **Deno Deploy**. It exposes Kimchi models behind
an OpenAI-compatible HTTP API: your client points its `base_url` here, the
proxy injects the Kimchi credential, and forwards to the Kimchi gateway.

## Routes

| Method | Path                     | Description                                   |
| ------ | ------------------------ | --------------------------------------------- |
| GET    | `/healthz`               | Liveness probe (no upstream call)             |
| GET    | `/`                      | Service info                                  |
| GET    | `/v1/models`             | List models (OpenAI list shape)               |
| POST   | `/v1/chat/completions`   | Chat completions (streaming + non-streaming)  |

## Files

- `gateway.ts` — the extracted Kimchi call-flow (auth + endpoint + gateway calls), env-only.
- `handler.ts` — platform-agnostic `Request → Response` handler. All logic lives here.
- `handler.test.ts` — unit/integration tests for the handler (run with vitest).
- `api/index.ts` — Vercel Edge Function entrypoint.
- `main.ts` — Deno Deploy entrypoint.
- `vercel.json` — routes all paths to the edge function.
- `deno.json` — Deno tasks + deploy entrypoint.

## Environment variables

| Variable                       | Required | Description                                                                 |
| ------------------------------ | -------- | --------------------------------------------------------------------------- |
| `KIMCHI_API_KEY`               | no       | Optional server-side fallback key, used only when a client sends no token.  |
| `KIMCHI_LLM_ENDPOINT`          | no       | Override the gateway base URL (default `https://llm.kimchi.dev`).           |

> **Bring-your-own-key:** each client sends its own Kimchi API key as the
> `Authorization: Bearer <key>` header, and the proxy forwards it upstream.
> The proxy is stateless and stores no credentials. `KIMCHI_API_KEY` is only a
> fallback for clients that omit the header — leave it unset for a pure BYOK
> deployment.

## Deploy to Vercel

```bash
cd deploy
# For a pure bring-your-own-key deployment, no env vars are required.
# (Optional) set a server-side fallback key for clients that omit the header:
vercel env add KIMCHI_API_KEY          # optional fallback (mark it as a Secret)
vercel deploy --prod
```

Then point any OpenAI client at `https://<your-app>.vercel.app/v1`.

## Deploy to Deno Deploy

```bash
cd deploy
# one-off via deployctl:
deployctl deploy --project=<your-project> --prod main.ts
# (optional) set KIMCHI_API_KEY in the Deno Deploy dashboard as a fallback key
```

Or connect the repo in the Deno Deploy dashboard with entrypoint `deploy/main.ts`.

Local dev: `deno task start` (listens on `http://localhost:8000`).

## Usage

Each client sends its own Kimchi API key as the bearer token:

```bash
curl https://<host>/v1/models \
  -H "Authorization: Bearer $KIMCHI_API_KEY"

curl https://<host>/v1/chat/completions \
  -H "Authorization: Bearer $KIMCHI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2-fp8","messages":[{"role":"user","content":"hi"}]}'
```

Any OpenAI SDK works by setting `base_url` to `https://<host>/v1` and `api_key`
to your Kimchi API key — the proxy forwards it upstream unchanged.

## Security notes

- The proxy is **stateless**: it forwards whatever key the client sends and
  stores nothing. Each user brings their own Kimchi credential.
- An optional server-side `KIMCHI_API_KEY` acts only as a fallback for clients
  that send no bearer token. For a public BYOK deployment, leave it unset so the
  proxy can't spend your own credits.
- A `402` from `/v1/chat/completions` means that client's Kimchi account is out
  of credits — the proxy forwards the upstream status unchanged.
```
