// AniList GraphQL Proxy for Deno Deploy
// Features: 1-hour cache, rate limit (25/min), browser headers, retry

const cache = new Map<string, { ts: number; data: string }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

const RATE_WINDOW = 60_000;
const RATE_MAX = 25; // safe under AniList's current 30/min limit
let rateLog: number[] = [];

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

async function hashQuery(body: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function checkRate(): boolean {
  const now = Date.now();
  rateLog = rateLog.filter((t) => now - t < RATE_WINDOW);
  if (rateLog.length >= RATE_MAX) return false;
  rateLog.push(now);
  return true;
}

function pickUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || res.status >= 500) {
        const backoff = Math.pow(2, attempt) * 1500 + Math.random() * 1000;
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      return res;
    } catch (e) {
      lastError = e as Error;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastError || new Error("Max retries exceeded");
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  // Health check
  if (url.pathname === "/" || url.pathname === "/health") {
    return new Response(
      JSON.stringify({
        ok: true,
        service: "anilist-proxy",
        runtime: "deno-deploy",
        cacheSize: cache.size,
        rateWindow: rateLog.length,
      }),
      { headers: { ...cors, "Content-Type": "application/json" } }
    );
  }

  // GraphQL proxy
  if (url.pathname === "/graphql" && req.method === "POST") {
    const body = await req.text();

    // Cache hit?
    const key = await hashQuery(body);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return new Response(cached.data, {
        headers: {
          ...cors,
          "Content-Type": "application/json",
          "X-Cache": "HIT",
        },
      });
    }

    // Rate limit check
    if (!checkRate()) {
      return new Response(
        JSON.stringify({ error: "Local rate limit hit. Retry in 60s." }),
        {
          status: 429,
          headers: { ...cors, "Content-Type": "application/json" },
        }
      );
    }

    // Forward to AniList
    try {
      const upstream = await fetchWithRetry("https://graphql.anilist.co", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": pickUA(),
          Origin: "https://anilist.co",
          Referer: "https://anilist.co/",
        },
        body,
      });

      const text = await upstream.text();

      if (upstream.status === 200) {
        cache.set(key, { ts: Date.now(), data: text });
        // Prune old entries
        if (cache.size > 3000) {
          const now = Date.now();
          for (const [k, v] of cache.entries()) {
            if (now - v.ts > CACHE_TTL) cache.delete(k);
          }
        }
      }

      return new Response(text, {
        status: upstream.status,
        headers: {
          ...cors,
          "Content-Type": "application/json",
          "X-Cache": "MISS",
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  }

  return new Response("Not found. Use POST /graphql", {
    status: 404,
    headers: cors,
  });
});
