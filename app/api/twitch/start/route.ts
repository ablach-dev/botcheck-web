import { NextRequest } from "next/server";

const WINDOW_MS = 3 * 60 * 1000;
const rateByIp = new Map<string, number>();

function getClientIp(request: NextRequest) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

function parseLastStart(value: string | undefined) {
  if (!value) return 0;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const now = Date.now();
  const ip = getClientIp(request);
  const cookieValue = request.cookies.get("bc_last_start")?.value;

  const lastByIp = rateByIp.get(ip) ?? 0;
  const lastByCookie = parseLastStart(cookieValue);
  const lastStart = Math.max(lastByIp, lastByCookie);
  const remaining = Math.max(0, WINDOW_MS - (now - lastStart));

  return new Response(
    JSON.stringify({
      allowed: remaining <= 0,
      retryAfter: Math.ceil(remaining / 1000)
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
}

export async function POST(request: NextRequest) {
  const now = Date.now();
  const ip = getClientIp(request);
  const cookieValue = request.cookies.get("bc_last_start")?.value;

  const lastByIp = rateByIp.get(ip) ?? 0;
  const lastByCookie = parseLastStart(cookieValue);
  const lastStart = Math.max(lastByIp, lastByCookie);

  if (lastStart && now - lastStart < WINDOW_MS) {
    const retryAfter = Math.ceil((WINDOW_MS - (now - lastStart)) / 1000);
    return new Response(
      JSON.stringify({ error: "Rate limit", retryAfter }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": retryAfter.toString(),
          "Cache-Control": "no-store"
        }
      }
    );
  }

  rateByIp.set(ip, now);

  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const cookie = `bc_last_start=${now}; Max-Age=180; Path=/; HttpOnly; SameSite=Lax${secure}`;

  return new Response(
    JSON.stringify({ ok: true }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": cookie,
        "Cache-Control": "no-store"
      }
    }
  );
}
