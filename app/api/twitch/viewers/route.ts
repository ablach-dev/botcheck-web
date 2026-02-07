import { NextRequest } from "next/server";

type RateBucket = {
  count: number;
  resetAt: number;
};

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const rateBuckets = new Map<string, RateBucket>();
const tokenCache = {
  token: "",
  expiresAt: 0
};

function getClientIp(request: NextRequest) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

function checkRateLimit(key: string) {
  const now = Date.now();
  const existing = rateBuckets.get(key);

  if (!existing || existing.resetAt <= now) {
    const bucket = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(key, bucket);
    return { ok: true, remaining: RATE_LIMIT_MAX - 1, resetAt: bucket.resetAt };
  }

  if (existing.count >= RATE_LIMIT_MAX) {
    return { ok: false, remaining: 0, resetAt: existing.resetAt };
  }

  existing.count += 1;
  return {
    ok: true,
    remaining: RATE_LIMIT_MAX - existing.count,
    resetAt: existing.resetAt
  };
}

export const runtime = "nodejs";

async function fetchAppAccessToken(clientId: string, clientSecret: string) {
  const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(
    clientId
  )}&client_secret=${encodeURIComponent(
    clientSecret
  )}&grant_type=client_credentials`;

  const response = await fetch(url, { method: "POST" });
  if (!response.ok) {
    throw new Error("Failed to fetch app access token");
  }

  const data = await response.json();
  if (!data.access_token || !data.expires_in) {
    throw new Error("Invalid token response");
  }

  tokenCache.token = data.access_token as string;
  tokenCache.expiresAt = Date.now() + data.expires_in * 1000;
  return data.access_token as string;
}

async function getAccessToken(
  clientId: string,
  clientSecret: string | undefined,
  fallbackToken: string | undefined
): Promise<string> {
  if (clientSecret) {
    if (tokenCache.token && tokenCache.expiresAt - 60_000 > Date.now()) {
      return tokenCache.token;
    }
    return fetchAppAccessToken(clientId, clientSecret);
  }

  if (fallbackToken) {
    return fallbackToken;
  }

  throw new Error("Missing Twitch credentials");
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const channel = searchParams.get("channel")?.toLowerCase();

  if (!channel || !/^[a-z0-9_]{1,25}$/.test(channel)) {
    return Response.json({ error: "Invalid channel" }, { status: 400 });
  }

  const key = getClientIp(request);
  const rate = checkRateLimit(key);
  if (!rate.ok) {
    const retryAfter = Math.max(0, Math.ceil((rate.resetAt - Date.now()) / 1000));
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded" }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": retryAfter.toString(),
          "X-RateLimit-Limit": RATE_LIMIT_MAX.toString(),
          "X-RateLimit-Remaining": rate.remaining.toString(),
          "X-RateLimit-Reset": rate.resetAt.toString()
        }
      }
    );
  }

  const clientId = process.env.TWITCH_CLIENT_ID ?? "";
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  const fallbackToken = process.env.TWITCH_ACCESS_TOKEN;

  if (!clientId) {
    return Response.json(
      { error: "Missing Twitch client ID" },
      { status: 500 }
    );
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(clientId, clientSecret, fallbackToken);
  } catch (err) {
    return Response.json(
      { error: "Missing Twitch credentials" },
      { status: 500 }
    );
  }

  const fetchHelix = async (token: string) => {
    const streamsUrl = `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(
      channel
    )}`;
    const usersUrl = `https://api.twitch.tv/helix/users?login=${encodeURIComponent(
      channel
    )}`;

    const headers = {
      "Client-Id": clientId,
      Authorization: `Bearer ${token}`
    };

    const [streamsRes, usersRes] = await Promise.all([
      fetch(streamsUrl, { headers, cache: "no-store" }),
      fetch(usersUrl, { headers, cache: "no-store" })
    ]);

    return { streamsRes, usersRes };
  };

  let response = await fetchHelix(accessToken);

  if (response.streamsRes.status === 401 && clientSecret) {
    try {
      accessToken = await fetchAppAccessToken(clientId, clientSecret);
      response = await fetchHelix(accessToken);
    } catch (err) {
      return Response.json(
        { error: "Failed to refresh Twitch token" },
        { status: 500 }
      );
    }
  }

  if (!response.streamsRes.ok) {
    return Response.json(
      { error: "Twitch API error" },
      { status: response.streamsRes.status }
    );
  }

  if (!response.usersRes.ok) {
    return Response.json(
      { error: "Twitch API error" },
      { status: response.usersRes.status }
    );
  }

  const streamsData = await response.streamsRes.json();
  const usersData = await response.usersRes.json();
  const live = Array.isArray(streamsData.data) && streamsData.data.length > 0;
  const viewers = live ? streamsData.data[0]?.viewer_count ?? 0 : 0;
  const displayName = usersData.data?.[0]?.display_name ?? null;

  return Response.json({ viewers, live, displayName });
}
