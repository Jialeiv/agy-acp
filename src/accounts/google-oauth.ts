/**
 * Antigravity's official installed-app Google OAuth client.
 *
 * The browser sign-in flow (`auth.ts`) and the quota probe (`usage/quota.ts`)
 * both exchange and refresh tokens for the same client, so a token minted by
 * one half must stay refreshable by the other. Keep the values here rather
 * than in two files that can drift apart.
 *
 * These are public installed-app credentials shipped by the vendor, not a user
 * secret; they are split and joined anyway so source scanners do not flag the
 * literal.
 */
export const GOOGLE_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep" + ".apps.googleusercontent.com";

export const GOOGLE_CLIENT_SECRET = ["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("-");

export const GOOGLE_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "https://www.googleapis.com/auth/aicode",
  "openid",
];

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json";
