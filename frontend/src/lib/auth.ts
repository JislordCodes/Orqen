/**
 * Optional bearer-token support for backends running AUTH_MODE=jwt.
 *
 * Keep it provider-agnostic: whatever auth SDK you add (Auth0, Clerk, Cognito, Supabase...) only has to
 * expose a function that returns the current access token, either by calling setTokenProvider() at
 * startup or by assigning window.orqenAuth = { getToken }. Without a provider the token is read from
 * localStorage[VITE_AUTH_TOKEN_STORAGE_KEY] (default "orqen_token"), which is handy for testing with a
 * token pasted in the console. No token -> no Authorization header (dev mode keeps using X-User-Id).
 */
export type TokenProvider = () => string | null | undefined | Promise<string | null | undefined>;

declare global {
  interface Window {
    orqenAuth?: { getToken: TokenProvider };
  }
}

let provider: TokenProvider | null = null;
const STORAGE_KEY = (import.meta.env.VITE_AUTH_TOKEN_STORAGE_KEY as string | undefined) || "orqen_token";

export function setTokenProvider(p: TokenProvider | null) {
  provider = p;
}

export async function getToken(): Promise<string | null> {
  try {
    const p = provider ?? window.orqenAuth?.getToken;
    if (p) return (await p()) || null;
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}
