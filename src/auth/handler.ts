import { AuthorizationError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import seedJson from "../../data/trails.seed.json";
import { handleAdmin } from "../admin";
import { makeDeps } from "../deps";
import { normalizeSeed } from "../domain/seed";
import type { Env } from "../env";
import { runEval } from "../eval/run";
import { reindexTrails, seedShared } from "../services/indexing";
import { chooseScopes, renderConsentPage } from "./consent-page";
import { exchangeGithubCode, fetchGithubUser, githubAuthorizeUrl, s256 } from "./github";

const html = (body: string, headers?: Headers) => {
  const h = new Headers(headers); // keeps the provider's binding cookie, frame-ancestors and no-cache headers
  h.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { status: 200, headers: h });
};

/**
 * Tampered or expired handles/state throw AuthorizationError: show a 400, not a 500.
 * Only when the library validated the client's redirect URI (`redirectTo` set, which happens
 * only for some parseAuthRequest failures) is the error sent back to the client instead.
 */
async function guarded(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      if (err.redirectTo) return Response.redirect(err.redirectTo, 302);
      return new Response(`Authorization error: ${err.description}`, {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    throw err;
  }
}

async function authorizeGet(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  return html(renderConsentPage(details, consent.handle), consent.headers);
}

async function authorizePost(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle, { scope: chooseScopes(form.getAll("scope").map(String)) });
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
  headers.set(
    "Location",
    githubAuthorizeUrl({
      clientId: env.GITHUB_CLIENT_ID,
      redirectUri: `${env.PUBLIC_BASE_URL}/callback`,
      state,
      codeChallenge: await s256(verifier),
    }),
  );
  return new Response(null, { status: 302, headers });
}

async function callback(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers: clear } = await oauth.finishUpstream<{ verifier: string }>(request);
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (params.get("error") || !code) {
    // The user declined at GitHub (or it failed): tell the MCP client with a standard OAuth error redirect.
    // authorizationErrorRedirect adds the client's state (when present) and iss (RFC 9207);
    // `original` came from storage via finishUpstream, so its redirectUri was validated.
    clear.set("Location", authorizationErrorRedirect(original, "access_denied", "GitHub sign-in was not completed"));
    return new Response(null, { status: 302, headers: clear });
  }
  const token = await exchangeGithubCode({
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    code,
    codeVerifier: data.verifier,
    redirectUri: `${env.PUBLIC_BASE_URL}/callback`,
  });
  const user = await fetchGithubUser(token); // the GitHub token is used once here and never stored
  const userId = String(user.id);
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId,
    metadata: {},
    scope: original.scope,
    props: { userId, scopes: original.scope },
  });
  clear.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: clear });
}

export const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize" && request.method === "GET") return guarded(() => authorizeGet(request, env));
    if (url.pathname === "/authorize" && request.method === "POST") return guarded(() => authorizePost(request, env));
    if (url.pathname === "/callback" && request.method === "GET") return guarded(() => callback(request, env));
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname.startsWith("/admin/")) {
      const deps = makeDeps(env);
      return handleAdmin(request, env.ADMIN_TOKEN, {
        seed: () => seedShared(deps, normalizeSeed(seedJson)),
        reindex: async (onlyUnindexed) => {
          if (!onlyUnindexed) await deps.repo.markAllPending(); // ?all=1 re-embeds everything, 20 rows per call
          return reindexTrails(deps);
        },
        evalRun: () => runEval(deps),
      });
    }
    if (url.pathname === "/") return new Response("Trailmates MCP server. Connect an MCP client to /mcp.");
    return new Response("Not found", { status: 404 });
  },
};
