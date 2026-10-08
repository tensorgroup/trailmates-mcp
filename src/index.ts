import { getProvider } from "./entry";
import type { Env } from "./env";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return getProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
