interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface D1Database {
  prepare(query: string): unknown;
}

declare module "cloudflare:workers" {
  export const env: {
    DB?: import("drizzle-orm/d1").AnyD1Database;
  };
}
