/**
 * Deno Deploy entrypoint.
 *
 * Deno Deploy runs a single module that calls `Deno.serve`. Env vars come from
 * the project's settings via `Deno.env`. The same shared handler powers both
 * this and the Vercel function.
 *
 * Local dev:   deno run --allow-net --allow-env main.ts
 * Deploy:      deployctl deploy --project=<name> main.ts
 *              (or connect the repo in the Deno Deploy dashboard)
 */

import { type Env, handleRequest } from "./handler.ts"

// `Deno` is provided by the Deno runtime; declared loosely so this file also
// type-checks under a Node-oriented tsconfig without the Deno types installed.
declare const Deno: {
	env: { get(key: string): string | undefined }
	serve(handler: (req: Request) => Response | Promise<Response>): unknown
}

function readEnv(): Env {
	return {
		KIMCHI_API_KEY: Deno.env.get("KIMCHI_API_KEY"),
		KIMCHI_LLM_ENDPOINT: Deno.env.get("KIMCHI_LLM_ENDPOINT"),
		KIMCHI_OPENAI_SERVICE_TOKEN: Deno.env.get("KIMCHI_OPENAI_SERVICE_TOKEN"),
	}
}

Deno.serve((req: Request) => handleRequest(req, readEnv()))
