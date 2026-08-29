import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import {
  authCookieOptions,
  hardenAuthCookieOptions,
} from "./lib/supabase/cookie-options.mjs";

function loginUrl(request: NextRequest) {
  const url = new URL("/login", request.url);
  url.searchParams.set("return_to", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return url;
}

export async function middleware(request: NextRequest) {
  if (process.env.GITHUB_PAGES === "1") {
    return NextResponse.next();
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const needsCurationAccess = request.nextUrl.pathname.startsWith("/curation");
  if (!url || !anonKey) {
    return needsCurationAccess
      ? NextResponse.redirect(loginUrl(request))
      : NextResponse.next();
  }

  const response = NextResponse.next({ request });
  const supabase = createServerClient(url, anonKey, {
    cookieOptions: authCookieOptions,
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value, options }) => {
          request.cookies.set(name, value);
          response.cookies.set(name, value, hardenAuthCookieOptions(options));
        });
        for (const [name, value] of Object.entries(headers)) {
          response.headers.set(name, value);
        }
      },
    },
  });

  const { data, error } = await supabase.auth.getClaims();
  if (needsCurationAccess && (error || !data?.claims?.sub)) {
    return NextResponse.redirect(loginUrl(request));
  }

  return response;
}

export const config = {
  matcher: ["/curation/:path*"],
};
