// app/api/debug/qstash/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mask(s: string) {
  if (!s) return "";
  if (s.length <= 8) return "********";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export async function GET() {
  const token = process.env.QSTASH_TOKEN || "";
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY || "";
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY || "";

  // No hacemos llamadas externas aquí. Solo validamos que existan envs.
  // Si quieres, luego lo extendemos para hacer un "publish ping" real.
  return NextResponse.json(
    {
      ok: true,
      env: {
        hasToken: Boolean(token),
        tokenMasked: mask(token),
        hasCurrentSigningKey: Boolean(currentSigningKey),
        currentSigningKeyMasked: mask(currentSigningKey),
        hasNextSigningKey: Boolean(nextSigningKey),
        nextSigningKeyMasked: nextSigningKey ? mask(nextSigningKey) : null,
      },
      note:
        "If this endpoint 404s on Vercel, it is not deployed (wrong path, wrong router, or missing commit/deploy).",
    },
    { status: 200, headers: { "Cache-Control": "no-store" } }
  );
}