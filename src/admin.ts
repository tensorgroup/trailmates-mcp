export interface AdminActions {
  seed(): Promise<unknown>;
  reindex(onlyUnindexed: boolean): Promise<unknown>;
  evalRun(): Promise<unknown>;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i]! ^ eb[i]!;
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleAdmin(request: Request, adminToken: string | undefined, actions: AdminActions): Promise<Response> {
  if (!adminToken) return new Response("Not found", { status: 404 });
  const provided = request.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
  if (!timingSafeEqual(provided, adminToken)) return new Response("Unauthorized", { status: 401 });
  const url = new URL(request.url);
  const known = ["/admin/seed", "/admin/reindex", "/admin/eval"];
  if (!known.includes(url.pathname)) return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (url.pathname === "/admin/seed") return json(await actions.seed());
  if (url.pathname === "/admin/reindex") return json(await actions.reindex(!url.searchParams.has("all")));
  return json(await actions.evalRun());
}
