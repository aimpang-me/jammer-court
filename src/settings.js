// Reads the Worker's vars once, at the boundary. Bad values fall back to safe defaults; without an API_KEY, MCP refuses.
import { MIN_KEY } from "./config.js";

export const DEFAULT_REPO = "https://github.com/aimpang-me/jammer-court";

export function settingsFrom(env = {}) {
  const httpsOr = (v, fallback) => (typeof v === "string" && /^https:\/\/\S+$/.test(v) ? v : fallback);
  const keyOr = (v) => (typeof v === "string" && v.length >= MIN_KEY ? v : null);
  const repoUrl = httpsOr(env.REPO_URL, DEFAULT_REPO);
  return {
    repoUrl,
    publicPage: env.PUBLIC_PAGE !== "false",
    apiKey: keyOr(env.API_KEY),
    // INGEST_KEY, when set, keeps the key Grok Bot holds from writing samples. Set but too short refuses; it never falls back.
    ingestKey: keyOr(env.INGEST_KEY === undefined ? env.API_KEY : env.INGEST_KEY),
  };
}
