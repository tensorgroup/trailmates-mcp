import { describe, expect, it } from "vitest";
import { exchangeGithubCode, fetchGithubUser, githubAuthorizeUrl, s256 } from "../src/auth/github";

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B vector", async () => {
    expect(await s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("githubAuthorizeUrl", () => {
  it("builds the GitHub authorize URL with state and PKCE and no scopes", () => {
    const u = new URL(githubAuthorizeUrl({ clientId: "cid", redirectUri: "https://x.dev/callback", state: "st", codeChallenge: "ch" }));
    expect(u.origin + u.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "cid", redirect_uri: "https://x.dev/callback", state: "st", code_challenge: "ch", code_challenge_method: "S256",
    });
  });
});

describe("exchangeGithubCode / fetchGithubUser", () => {
  it("exchanges a code for a token", async () => {
    let body = "";
    const f = (async (_url: string, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ access_token: "gho_abc" }), { status: 200 });
    }) as unknown as typeof fetch;
    const token = await exchangeGithubCode({ clientId: "c", clientSecret: "s", code: "code1", codeVerifier: "v", redirectUri: "https://x.dev/callback" }, f);
    expect(token).toBe("gho_abc");
    expect(body).toContain("code=code1");
    expect(body).toContain("code_verifier=v");
  });
  it("throws without echoing secrets when GitHub returns an error", async () => {
    const f = (async () => new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 200 })) as unknown as typeof fetch;
    await expect(exchangeGithubCode({ clientId: "c", clientSecret: "TOPSECRET", code: "x", codeVerifier: "v", redirectUri: "r" }, f)).rejects.toThrow(/github/i);
    await expect(exchangeGithubCode({ clientId: "c", clientSecret: "TOPSECRET", code: "x", codeVerifier: "v", redirectUri: "r" }, f)).rejects.not.toThrow(/TOPSECRET/);
  });
  it("reads the numeric user id", async () => {
    const f = (async () => new Response(JSON.stringify({ id: 4242, login: "octo" }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchGithubUser("tok", f)).toEqual({ id: 4242, login: "octo" });
  });
  it("rejects a user response without a numeric id", async () => {
    const f = (async () => new Response(JSON.stringify({ login: "octo" }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchGithubUser("tok", f)).rejects.toThrow();
  });
});
