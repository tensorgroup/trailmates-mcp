import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const SUPPORTED_SCOPES = ["mcp:read", "mcp:write"];

/** Always includes mcp:read; keeps only supported scopes from the form. */
export function chooseScopes(formScopes: string[]): string[] {
  return [...new Set(["mcp:read", ...formScopes.filter((s) => SUPPORTED_SCOPES.includes(s))])];
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export function renderConsentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const requested = details.scope.map(escape).join(", ") || "none";
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<style>body{font:16px system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem}</style>
<h1>Allow ${name} to use Trailmates?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>" : ""}
<p>The app asked for: ${requested}</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <input type="hidden" name="scope" value="mcp:read">
  <p>Search trails and see your private hikes (always included).</p>
  <p><label><input type="checkbox" name="scope" value="mcp:write" checked> Add and delete your private hikes</label></p>
  <p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
</form>`;
}
