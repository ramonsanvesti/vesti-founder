import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const token = process.env.QSTASH_TOKEN || "";
  const hasToken = Boolean(token);

  if (!hasToken) {
    return NextResponse.json({ ok: false, hasToken: false, error: "QSTASH_TOKEN missing" }, { status: 500 });
  }

  const target = "https://example.com";
  const publishUrl = `https://qstash.upstash.io/v2/publish/${encodeURIComponent(target)}`;

  const r = await fetch(publishUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Upstash-Method": "POST",
      "Upstash-Content-Type": "application/json",
      "Upstash-Deduplication-Id": "vesti-debug-ping",
      "Upstash-Retries": "0",
    },
    body: JSON.stringify({ ping: true, at: Date.now() }),
  });

  const body = await r.text().catch(() => "");
  return NextResponse.json(
    {
      ok: r.ok,
      hasToken: true,
      status: r.status,
      body: body.slice(0, 300),
    },
    { status: r.ok ? 200 : 502 }
  );
}