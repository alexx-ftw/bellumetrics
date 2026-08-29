import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import {
  authCookieOptions,
  hardenAuthCookieOptions,
} from "../../../lib/supabase/cookie-options.mjs";

function safeNextUrl(request: NextRequest, value: string | null): URL {
  const fallback = new URL("/curation", request.url);
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return fallback;
  }

  const target = new URL(value, request.url);
  return target.origin === request.nextUrl.origin && target.pathname.startsWith("/")
    ? target
    : fallback;
}

export async function GET(request: NextRequest) {
  if (process.env.GITHUB_PAGES === "1") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const destination = safeNextUrl(request, request.nextUrl.searchParams.get("next"));
  const code = request.nextUrl.searchParams.get("code");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!code || !url || !anonKey) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const response = NextResponse.redirect(destination);
  const supabase = createServerClient(url, anonKey, {
    cookieOptions: authCookieOptions,
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, hardenAuthCookieOptions(options));
        });
        for (const [name, value] of Object.entries(headers)) {
          response.headers.set(name, value);
        }
      },
    },
  });

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  return error
    ? NextResponse.redirect(new URL("/login", request.url))
    : response;
}
