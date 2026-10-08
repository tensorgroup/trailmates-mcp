import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { SUPPORTED_SCOPES } from "./auth/consent-page";
import { authHandler } from "./auth/handler";
import type { Env } from "./env";
import { createServer } from "./mcp/server";

const mcpApi = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
};

let provider: OAuthProvider<Env> | undefined;
function getProvider(env: Env): OAuthProvider<Env> {
  provider ??= new OAuthProvider<Env>({
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
  });
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return getProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
