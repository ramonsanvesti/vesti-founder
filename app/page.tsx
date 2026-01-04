import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

type LeadUtm = {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
};

type LeadPayload = {
  email?: unknown;
  name?: unknown;
  consent?: unknown;
  company?: unknown; // honeypot
  utm?: unknown;
};

function asUtm(value: unknown): LeadUtm | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const out: LeadUtm = {};
  for (const k of ["source", "medium", "campaign", "term", "content"] as const) {
    const x = v[k];
    if (typeof x === "string" && x.trim()) out[k] = x.trim();
  }
  return Object.keys(out).length ? out : null;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as LeadPayload;

    const email = String(body?.email ?? "").trim().toLowerCase();
    const name = String(body?.name ?? "").trim();
    const consent = Boolean(body?.consent ?? true);

    // Honeypot: if filled, treat as bot and respond OK without writing.
    const company = String(body?.company ?? "").trim();
    if (company) return NextResponse.json({ ok: true }, { status: 200 });

    if (!email || !isValidEmail(email)) {
      return NextResponse.json({ ok: false, error: "Invalid email" }, { status: 400 });
    }

    if (!consent) {
      return NextResponse.json({ ok: false, error: "Consent required" }, { status: 400 });
    }

    const sb = supabaseAdmin();
    const utm = asUtm(body?.utm);

    const { error } = await sb.from("leads").upsert(
      {
        email,
        name: name || null,
        source: "dresz.io",
        consent: true,
        consent_at: new Date().toISOString(),
        user_agent: req.headers.get("user-agent") ?? null,
        utm,
      },
      { onConflict: "email" }
    );

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request" }, { status: 400 });
  }
}
