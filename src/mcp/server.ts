import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { makeDeps } from "../deps";
import type { Env } from "../env";
import {
  addHikeShape, addHikeTool, callTool, deleteHikeShape, deleteHikeTool, resolveToolAuth, searchHikesShape,
  searchHikesTool, type ToolContext,
} from "./tools";

type CallbackContext = { http?: { authInfo?: { scopes?: string[] } } };

function toolContext(env: Env, context: CallbackContext): ToolContext {
  const auth = resolveToolAuth(getMcpAuthContext()?.props, context.http?.authInfo?.scopes);
  return { deps: makeDeps(env), ...auth };
}

export function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "trailmates-mcp", version: "0.1.0" });

  server.registerTool(
    "search_hikes",
    {
      description:
        "Find hikes by meaning, e.g. 'shaded creek walk with a waterfall'. Searches the shared LA-area trails plus the caller's private hikes. Closed trails are hidden by default. Set include_closed to true whenever the user asks about closed trails, mentions a closure, or asks about a specific trail that might be closed. The response includes hidden_closed: how many closed trails would have appeared in these results. A trail named exactly is always returned with its status. Distances and gain are matched on a trail's upper bound.",
      inputSchema: z.object(searchHikesShape),
      annotations: { readOnlyHint: true },
    },
    (args, context) => callTool(() => searchHikesTool(toolContext(env, context), args)),
  );

  server.registerTool(
    "add_hike",
    {
      description:
        "Add a private hike visible only to you. Re-adding the same name and trailhead updates it. A new hike usually appears in search within seconds, occasionally a minute or more; searching by its exact name works immediately.",
      inputSchema: z.object(addHikeShape),
    },
    (args, context) => callTool(() => addHikeTool(toolContext(env, context), args)),
  );

  server.registerTool(
    "delete_hike",
    {
      description: "Delete one of your own private hikes by id. Shared trails cannot be deleted.",
      inputSchema: z.object(deleteHikeShape),
      annotations: { destructiveHint: true },
    },
    (args, context) => callTool(() => deleteHikeTool(toolContext(env, context), args)),
  );

  return server;
}
