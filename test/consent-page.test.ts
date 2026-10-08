import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";
import { SUPPORTED_SCOPES, chooseScopes, renderConsentPage } from "../src/auth/consent-page";

const details: ConsentDescription = {
  clientId: "client-1",
  clientName: '<script>alert("x")</script>',
  redirectUri: "http://localhost:3000/cb",
  redirectHost: "localhost",
  redirectIsLoopback: true,
  scope: ["mcp:read", 'mcp:"write"'],
};

describe("renderConsentPage", () => {
  it("escapes everything that came from the client", () => {
    const html = renderConsentPage(details, 'h"andle');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#60;script&#62;");
    expect(html).not.toContain('value="h"andle"');
    expect(html).toContain("mcp:&#34;write&#34;");
    expect(html).not.toContain('mcp:"write"');
  });
  it("escapes a hostile clientDomain and redirectHost", () => {
    const html = renderConsentPage(
      { ...details, clientDomain: '<b onmouseover="x">evil.example</b>', redirectHost: "<img src=x>'host'", redirectIsLoopback: false },
      "h",
    );
    expect(html).toContain("Published by <strong>&#60;b onmouseover=&#34;x&#34;&#62;evil.example&#60;/b&#62;</strong>");
    expect(html).toContain("<strong>&#60;img src=x&#62;&#39;host&#39;</strong>");
    expect(html).not.toContain("<b onmouseover");
    expect(html).not.toContain("<img");
  });
  it("shows the redirect host, a loopback warning, and approve/deny buttons", () => {
    const html = renderConsentPage(details, "h");
    expect(html).toContain("localhost");
    expect(html).toMatch(/computer/i);
    expect(html).toContain('value="approve"');
    expect(html).toContain('value="deny"');
  });
  it("always sends mcp:read and offers mcp:write as a checked option", () => {
    const html = renderConsentPage(details, "h");
    expect(html).toContain('<input type="hidden" name="scope" value="mcp:read">');
    expect(html).toMatch(/<input type="checkbox" name="scope" value="mcp:write" checked>/);
  });
});

describe("chooseScopes", () => {
  it("always includes mcp:read, keeps supported scopes once, and drops unknown ones", () => {
    expect(chooseScopes([])).toEqual(["mcp:read"]);
    expect(chooseScopes(["mcp:write", "admin", "mcp:write"]).sort()).toEqual(["mcp:read", "mcp:write"]);
  });
  it("supports exactly read and write", () => {
    expect(SUPPORTED_SCOPES).toEqual(["mcp:read", "mcp:write"]);
  });
});
