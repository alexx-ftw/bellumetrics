export const authCookieOptions = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
});

export function hardenAuthCookieOptions(options = {}) {
  return { ...options, ...authCookieOptions };
}
