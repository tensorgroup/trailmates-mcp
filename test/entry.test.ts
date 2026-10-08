import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { getMcpHandler, getProvider } from "../src/entry";

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
