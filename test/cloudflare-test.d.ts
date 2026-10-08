declare module "cloudflare:test" {
  export const env: Record<string, unknown>;
}
declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}
