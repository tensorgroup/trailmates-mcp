import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { SUPPORTED_SCOPES } from "./auth/consent-page";
import { authHandler } from "./auth/handler";
import type { Env } from "./env";
import { createServer } from "./mcp/server";

// Built once per isolate and reused across requests. Each memo carries the inputs it was built from,
// so a different env (tests, a redeploy) never gets a stale instance.

type McpFetch = ReturnType<typeof createMcpHandler>;
let mcp: { env: Env; handler: McpFetch } | undefined;

/** The server factory still runs per request; only the handler wrapper is reused. Keyed on env identity. */
export function getMcpHandler(env: Env): McpFetch {
  if (mcp?.env !== env) mcp = { env, handler: createMcpHandler(() => createServer(env)) };
  return mcp.handler;
}

const mcpApi = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return getMcpHandler(env)(request, env, ctx);
  },
};

let provider: { baseUrl: string; instance: OAuthProvider<Env> } | undefined;

/** Handlers receive env per request; only PUBLIC_BASE_URL is baked in, so it is the memo key. */
export function getProvider(env: Env): OAuthProvider<Env> {
  if (provider?.baseUrl !== env.PUBLIC_BASE_URL) {
    provider = {
      baseUrl: env.PUBLIC_BASE_URL,
      instance: new OAuthProvider<Env>({
        apiRoute: "/mcp",
        apiHandler: mcpApi,
        defaultHandler: authHandler,
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/oauth/token",
        clientRegistrationEndpoint: "/oauth/register",
        scopesSupported: SUPPORTED_SCOPES,
        requiredScopes: ["mcp:read"],
        resourceMetadata: {
          resource: `${env.PUBLIC_BASE_URL}/mcp`,
          authorization_servers: [env.PUBLIC_BASE_URL],
        },
      }),
    };
  }
  return provider.instance;
}
