import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  AI: Ai;
  DB: D1Database;
  VECTORIZE: Vectorize;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  PUBLIC_BASE_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ADMIN_TOKEN?: string;
}
