function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function githubAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("state", p.state);
  u.searchParams.set("code_challenge", p.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export async function exchangeGithubCode(
  p: { clientId: string; clientSecret: string; code: string; codeVerifier: string; redirectUri: string },
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchFn("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code: p.code,
      code_verifier: p.codeVerifier,
      redirect_uri: p.redirectUri,
    }).toString(),
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !json.access_token) throw new Error(`GitHub token exchange failed: ${json.error ?? res.status}`);
  return json.access_token;
}

export async function fetchGithubUser(token: string, fetchFn: typeof fetch = fetch): Promise<{ id: number; login: string }> {
  const res = await fetchFn("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "trailmates-mcp" },
  });
  const json = (await res.json()) as { id?: unknown; login?: unknown };
  if (!res.ok || typeof json.id !== "number" || typeof json.login !== "string") {
    throw new Error("GitHub user lookup failed");
  }
  return { id: json.id, login: json.login };
}
