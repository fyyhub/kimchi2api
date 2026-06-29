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

| Variable                       | Required | Description                                                        |
| ------------------------------ | -------- | ------------------------------------------------------------------ |
| `KIMCHI_API_KEY`               | yes      | Upstream Kimchi credential (from `kimchi login`).                  |
| `KIMCHI_LLM_ENDPOINT`          | no       | Override the gateway base URL (default `https://llm.kimchi.dev`).  |
| `KIMCHI_OPENAI_SERVICE_TOKEN`  | no       | If set, clients must send `Authorization: Bearer <token>`.         |

> Unlike the CLI version, credentials come **only** from the environment —
> there is no `~/.config/kimchi/config.json` on a serverless host.

## Deploy to Vercel

```bash
cd deploy
vercel env add KIMCHI_API_KEY          # paste your key (mark it as a Secret)
vercel env add KIMCHI_OPENAI_SERVICE_TOKEN   # optional: protect the proxy
vercel deploy --prod
```

Then point any OpenAI client at `https://<your-app>.vercel.app/v1`.

## Deploy to Deno Deploy

```bash
cd deploy
# one-off via deployctl:
deployctl deploy --project=<your-project> --prod main.ts
# set env vars in the Deno Deploy dashboard: KIMCHI_API_KEY (+ optional token)
```

Or connect the repo in the Deno Deploy dashboard with entrypoint `deploy/main.ts`.

Local dev: `deno task start` (listens on `http://localhost:8000`).

## Usage

```bash
# without a proxy token
curl https://<host>/v1/models

# with a proxy token configured
curl https://<host>/v1/chat/completions \
  -H "Authorization: Bearer $KIMCHI_OPENAI_SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2-fp8","messages":[{"role":"user","content":"hi"}]}'
```

Any OpenAI SDK works by setting `base_url` to `https://<host>/v1` and `api_key`
to your proxy token (or any non-empty string when no token is configured).

## Security notes

- The proxy holds your `KIMCHI_API_KEY` server-side and never returns it.
- Without `KIMCHI_OPENAI_SERVICE_TOKEN`, the deployed URL is **open to anyone
  who finds it** and will spend your Kimchi credits. Set the token for any
  public deployment.
- A `402` from `/v1/chat/completions` means the Kimchi account is out of
  credits — the proxy forwards the upstream status unchanged.
```
