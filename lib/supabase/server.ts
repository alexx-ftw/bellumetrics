import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import {
  authCookieOptions,
  hardenAuthCookieOptions,
} from "./cookie-options.mjs";

export async function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("Supabase server authentication is not configured.");
  }

  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookieOptions: authCookieOptions,
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, hardenAuthCookieOptions(options));
          });
        } catch {
          // Server Components cannot persist refreshed cookies. middleware.ts
          // refreshes the session before rendering protected pages.
        }
      },
    },
  });
}
