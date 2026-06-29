/**
 * Vercel Edge Function entrypoint.
 *
 * Vercel routes every path under this project to this function (see
 * ../vercel.json rewrites). It reads env vars from `process.env` (populated
 * from the Vercel project's Environment Variables) and delegates to the shared
 * Web-standard handler.
 */

import { type Env, handleRequest } from "../handler.ts"

export const config = { runtime: "edge" }

function readEnv(): Env {
	return {
		KIMCHI_API_KEY: process.env.KIMCHI_API_KEY,
		KIMCHI_LLM_ENDPOINT: process.env.KIMCHI_LLM_ENDPOINT,
	}
}

export default async function handler(req: Request): Promise<Response> {
	return handleRequest(req, readEnv())
}
