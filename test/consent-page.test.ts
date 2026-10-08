import { describe, expect, it } from "vitest";
import { SUPPORTED_SCOPES, chooseScopes, renderConsentPage } from "../src/auth/consent-page";

const details = {
  clientName: '<script>alert("x")</script>',
  clientDomain: null,
  redirectHost: "localhost",
  redirectIsLoopback: true,
  scope: ["mcp:read", 'mcp:"write"'],
} as never;

describe("renderConsentPage", () => {
  it("escapes everything that came from the client", () => {
    const html = renderConsentPage(details, 'h"andle');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#60;script&#62;");
    expect(html).not.toContain('value="h"andle"');
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
