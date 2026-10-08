import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { getMcpHandler, getProvider, mcpAllowedHostnames } from "../src/entry";

const fakeEnv = (base: string) => ({ PUBLIC_BASE_URL: base }) as unknown as Env;

describe("worker entry memoization", () => {
  it("reuses the MCP handler for the same env object and rebuilds it for a different one", () => {
    const a = fakeEnv("https://a.example");
    expect(getMcpHandler(a)).toBe(getMcpHandler(a));
    expect(getMcpHandler(fakeEnv("https://a.example"))).not.toBe(getMcpHandler(a));
  });
  it("reuses the provider while PUBLIC_BASE_URL is unchanged and rebuilds it when it changes", () => {
    const first = getProvider(fakeEnv("https://a.example"));
    expect(getProvider(fakeEnv("https://a.example"))).toBe(first);
    const moved = getProvider(fakeEnv("https://b.example"));
    expect(moved).not.toBe(first);
    expect(getProvider(fakeEnv("https://b.example"))).toBe(moved);
  });
});

describe("mcpAllowedHostnames", () => {
  it("follows the hostname of PUBLIC_BASE_URL", () => {
    expect(mcpAllowedHostnames(fakeEnv("https://trailmates.example.org"))).toEqual(["trailmates.example.org"]);
    expect(mcpAllowedHostnames(fakeEnv("https://other.example"))).toEqual(["other.example"]);
  });
  it("drops any path, port or trailing slash", () => {
    expect(mcpAllowedHostnames(fakeEnv("https://mcp.example.com:8443/base/path/"))).toEqual(["mcp.example.com"]);
    expect(mcpAllowedHostnames(fakeEnv("http://localhost:8787"))).toEqual(["localhost"]);
  });
});

describe("MCP handler host check", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const post = (host: string) =>
    new Request(`https://${host}/mcp`, {
      method: "POST",
      headers: { host, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
  it("rejects a Host that does not match PUBLIC_BASE_URL and accepts one that does", async () => {
    const env = fakeEnv("https://trailmates.example.org");
    const foreign = await getMcpHandler(env)(post("evil.example"), env, ctx);
    expect(foreign.status).toBe(403);
    expect(await foreign.text()).toContain("Invalid Host");
    const own = await getMcpHandler(env)(post("trailmates.example.org"), env, ctx);
    expect(own.status).not.toBe(403);
  });
});
