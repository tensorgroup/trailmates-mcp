import { AuthorizationError, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authHandler } from "../src/auth/handler";
import { s256 } from "../src/auth/github";
import type { Env } from "../src/env";

const BASE = "https://mcp.example.dev";

const authReq = (over: Partial<AuthRequest> = {}): AuthRequest => ({
  responseType: "code",
  clientId: "client-1",
  redirectUri: "https://client.example/cb",
  scope: ["mcp:read", "mcp:write"],
  state: "client-state",
  issuer: BASE,
  ...over,
});

/** Throws on any use, so a test fails loudly if a code path touches the binding. */
const forbidden = (name: string) =>
  new Proxy({}, { get: (_t, p) => { throw new Error(`${name}.${String(p)} must not be used`); } });

interface FakeOptions {
  original?: AuthRequest;
  upstreamData?: unknown;
  throwFrom?: { method: keyof OAuthHelpers; error: Error };
}

function fakeOAuth(opts: FakeOptions = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const original = opts.original ?? authReq();
  const record = (method: keyof OAuthHelpers, args: unknown[]) => {
    calls.push({ method, args });
    if (opts.throwFrom?.method === method) throw opts.throwFrom.error;
  };
  const helpers = {
    async parseAuthRequest(...args: unknown[]) { record("parseAuthRequest", args); return authReq(); },
    async describeConsent(...args: unknown[]) {
      record("describeConsent", args);
      return {
        clientId: "client-1",
        clientName: '<img src=x onerror="alert(1)">',
        redirectUri: "https://client.example/cb",
        redirectHost: "client.example",
        redirectIsLoopback: false,
        scope: ["mcp:read"],
      };
    },
    async beginConsent(...args: unknown[]) {
      record("beginConsent", args);
      return {
        handle: 'hand"le<1>',
        headers: new Headers({
          "Set-Cookie": "__Host-oauth-consent-abc=hash; Secure; HttpOnly; Path=/",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "frame-ancestors 'none'",
          "X-Frame-Options": "DENY",
        }),
      };
    },
    async approveConsent(...args: unknown[]) {
      record("approveConsent", args);
      const scope = (args[2] as { scope: string[] }).scope;
      return { request: { ...authReq(), scope }, headers: new Headers({ "Set-Cookie": "__Host-oauth-consent-abc=; Max-Age=0" }) };
    },
    async denyConsent(...args: unknown[]) {
      record("denyConsent", args);
      const redirectTo = "https://client.example/cb?error=access_denied&state=client-state";
      return { request: authReq(), redirectTo, headers: new Headers({ Location: redirectTo, "Cache-Control": "no-store" }) };
    },
    async beginUpstream(...args: unknown[]) {
      record("beginUpstream", args);
      const headers = (args[1] as { headers: Headers }).headers;
      headers.append("Set-Cookie", "__Host-oauth-upstream-xyz=hash; Secure; HttpOnly; Path=/");
      return { state: "upstream-state-123", headers };
    },
    async finishUpstream(...args: unknown[]) {
      record("finishUpstream", args);
      return {
        request: original,
        data: opts.upstreamData ?? { verifier: "the-verifier" },
        headers: new Headers({ "Cache-Control": "no-store", "Set-Cookie": "__Host-oauth-upstream-xyz=; Max-Age=0" }),
      };
    },
    async completeAuthorization(...args: unknown[]) {
      record("completeAuthorization", args);
      return { redirectTo: "https://client.example/cb?code=mcp-code&state=client-state" };
    },
  };
  return { helpers: helpers as unknown as OAuthHelpers, calls };
}

function makeEnv(oauth: OAuthHelpers, over: Partial<Env> = {}): Env {
  return {
    AI: forbidden("AI") as Ai,
    DB: forbidden("DB") as D1Database,
    VECTORIZE: forbidden("VECTORIZE") as Vectorize,
    OAUTH_KV: forbidden("OAUTH_KV") as KVNamespace,
    OAUTH_PROVIDER: oauth,
    PUBLIC_BASE_URL: BASE,
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-SECRET",
    ...over,
  };
}

const post = (path: string, fields: [string, string][]) => {
  const body = new URLSearchParams(fields);
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://github.com/login/oauth/access_token") {
      return new Response(JSON.stringify({ access_token: "gho_token" }), { status: 200 });
    }
    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify({ id: 4242, login: "octocat" }), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /authorize", () => {
  it("renders the consent page with beginConsent's headers and escapes client data", async () => {
    const { helpers, calls } = fakeOAuth();
    const res = await authHandler.fetch(new Request(`${BASE}/authorize?client_id=client-1`), makeEnv(helpers));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Set-Cookie")).toContain("__Host-oauth-consent-abc=hash");
    expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain('name="handle" value="hand&#34;le&#60;1&#62;"');
    expect(body).not.toContain("<img");
    expect(body).toContain("&#60;img src=x onerror=&#34;alert(1)&#34;&#62;");
    expect(calls.map((c) => c.method)).toEqual(["parseAuthRequest", "describeConsent", "beginConsent"]);
  });
});

describe("POST /authorize", () => {
  it("deny: calls denyConsent and returns its redirect, without starting upstream", async () => {
    const { helpers, calls } = fakeOAuth();
    const res = await authHandler.fetch(post("/authorize", [["handle", "h1"], ["decision", "deny"]]), makeEnv(helpers));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://client.example/cb?error=access_denied&state=client-state");
    expect(calls.map((c) => c.method)).toEqual(["denyConsent"]);
    expect(calls[0]!.args[1]).toBe("h1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("approve: re-validates scopes, approves, THEN begins upstream and redirects to GitHub with state and S256", async () => {
    const { helpers, calls } = fakeOAuth();
    const res = await authHandler.fetch(
      post("/authorize", [["handle", "h1"], ["decision", "approve"], ["scope", "mcp:write"], ["scope", "admin"]]),
      makeEnv(helpers),
    );
    expect(res.status).toBe(302);
    expect(calls.map((c) => c.method)).toEqual(["approveConsent", "beginUpstream"]);

    const [, handle, approveOpts] = calls[0]!.args as [Request, string, { scope: string[] }];
    expect(handle).toBe("h1");
    expect([...approveOpts.scope].sort()).toEqual(["mcp:read", "mcp:write"]);

    const [upstreamReq, upstreamOpts] = calls[1]!.args as [AuthRequest, { data: { verifier: string }; headers: Headers }];
    expect([...upstreamReq.scope].sort()).toEqual(["mcp:read", "mcp:write"]);

    const location = new URL(res.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("state")).toBe("upstream-state-123");
    expect(location.searchParams.get("client_id")).toBe("gh-client");
    expect(location.searchParams.get("redirect_uri")).toBe(`${BASE}/callback`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBe(await s256(upstreamOpts.data.verifier));
    // Both the consent-clear cookie and the upstream binding cookie are sent.
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("__Host-oauth-consent-abc=;"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("__Host-oauth-upstream-xyz=hash"))).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("approve with no scopes ticked still grants mcp:read only", async () => {
    const { helpers, calls } = fakeOAuth();
    await authHandler.fetch(post("/authorize", [["handle", "h1"], ["decision", "approve"]]), makeEnv(helpers));
    expect((calls[0]!.args[2] as { scope: string[] }).scope).toEqual(["mcp:read"]);
  });
});

describe("GET /callback", () => {
  it("exchanges the code, reads the numeric GitHub id, and completes with userId as a string", async () => {
    const original = authReq({ scope: ["mcp:read"] });
    const { helpers, calls } = fakeOAuth({ original });
    const res = await authHandler.fetch(new Request(`${BASE}/callback?code=gh-code&state=upstream-state-123`), makeEnv(helpers));

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://client.example/cb?code=mcp-code&state=client-state");
    expect(res.headers.get("Set-Cookie")).toContain("__Host-oauth-upstream-xyz=; Max-Age=0");
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    expect(calls.map((c) => c.method)).toEqual(["finishUpstream", "completeAuthorization"]);
    const opts = calls[1]!.args[0] as { request: AuthRequest; userId: string; scope: string[]; props: unknown };
    expect(opts.request).toBe(original);
    expect(opts.userId).toBe("4242");
    expect(opts.scope).toEqual(["mcp:read"]);
    expect(opts.props).toEqual({ userId: "4242", scopes: ["mcp:read"] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const tokenBody = String((fetchMock.mock.calls[0]![1] as RequestInit).body);
    expect(tokenBody).toContain("code=gh-code");
    expect(tokenBody).toContain("code_verifier=the-verifier");
    expect(tokenBody).toContain(`redirect_uri=${encodeURIComponent(`${BASE}/callback`)}`);
  });

  it("a declined GitHub sign-in redirects the client with access_denied, state and iss, and calls no GitHub API", async () => {
    const { helpers, calls } = fakeOAuth();
    const res = await authHandler.fetch(
      new Request(`${BASE}/callback?error=access_denied&state=upstream-state-123`),
      makeEnv(helpers),
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://client.example/cb");
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("client-state");
    expect(loc.searchParams.get("iss")).toBe(BASE);
    expect(res.headers.get("Set-Cookie")).toContain("__Host-oauth-upstream-xyz=; Max-Age=0");
    expect(calls.map((c) => c.method)).toEqual(["finishUpstream"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", `${BASE}/callback?state=upstream-state-123`],
    ["empty", `${BASE}/callback?code=&state=upstream-state-123`],
  ])("a callback with a %s code is treated as declined", async (_label, url) => {
    const { helpers, calls } = fakeOAuth();
    const res = await authHandler.fetch(new Request(url), makeEnv(helpers));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
    expect(calls.map((c) => c.method)).toEqual(["finishUpstream"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AuthorizationError handling", () => {
  it("a tampered/expired state (AuthorizationError without redirectTo) is a 400 with no-store, not a 500", async () => {
    const error = new AuthorizationError("invalid_request", { description: "Transaction expired or already used" });
    const { helpers } = fakeOAuth({ throwFrom: { method: "finishUpstream", error } });
    const res = await authHandler.fetch(new Request(`${BASE}/callback?code=c&state=bogus`), makeEnv(helpers));
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toContain("Transaction expired or already used");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a tampered consent handle on POST is a 400 and never starts upstream", async () => {
    const error = new AuthorizationError("invalid_request", { description: "Consent handle is not bound to this browser" });
    const { helpers, calls } = fakeOAuth({ throwFrom: { method: "approveConsent", error } });
    const res = await authHandler.fetch(post("/authorize", [["handle", "forged"], ["decision", "approve"]]), makeEnv(helpers));
    expect(res.status).toBe(400);
    expect(calls.map((c) => c.method)).toEqual(["approveConsent"]);
  });

  it("an AuthorizationError carrying a validated redirect is sent back to the client", async () => {
    const error = new AuthorizationError("invalid_scope", {
      description: "bad scope",
      redirectUri: "https://client.example/cb",
      state: "client-state",
    });
    expect(error.redirectTo).toBeDefined();
    const { helpers } = fakeOAuth({ throwFrom: { method: "parseAuthRequest", error } });
    const res = await authHandler.fetch(new Request(`${BASE}/authorize?client_id=client-1`), makeEnv(helpers));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(error.redirectTo);
  });

  it("a non-authorization error is not swallowed", async () => {
    const { helpers } = fakeOAuth({ throwFrom: { method: "parseAuthRequest", error: new TypeError("kv down") } });
    await expect(authHandler.fetch(new Request(`${BASE}/authorize`), makeEnv(helpers))).rejects.toThrow("kv down");
  });
});

describe("admin routes through authHandler", () => {
  it("are 404 without ADMIN_TOKEN and 401 with a wrong/missing token, touching no bindings", async () => {
    const { helpers, calls } = fakeOAuth();
    const seed = (auth?: string) =>
      new Request(`${BASE}/admin/seed`, { method: "POST", headers: auth ? { authorization: auth } : {} });
    expect((await authHandler.fetch(seed("Bearer x"), makeEnv(helpers))).status).toBe(404);
    const env = makeEnv(helpers, { ADMIN_TOKEN: "s3cret" });
    expect((await authHandler.fetch(seed(), env)).status).toBe(401);
    expect((await authHandler.fetch(seed("Bearer wrong"), env)).status).toBe(401);
    expect(calls).toEqual([]);
  });
});
