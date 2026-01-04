import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const email = String(body?.email ?? "").trim().toLowerCase();
    const name = String(body?.name ?? "").trim();
    const consent = Boolean(body?.consent ?? true);

    // Honeypot (campo invisible en UI). Si viene lleno, es bot.
    const company = String(body?.company ?? "").trim();
    if (company) {
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    if (!email || !isValidEmail(email)) {
      return NextResponse.json({ ok: false, error: "Invalid email" }, { status: 400 });
    }

    if (!consent) {
      return NextResponse.json({ ok: false, error: "Consent required" }, { status: 400 });
    }

    const sb = supabaseAdmin();

    // Upsert por email (dedupe)
    const { error } = await sb
      .from("leads")
      .upsert(
        {
          email,
          name: name || null,
          source: "dresz.io",
          consent: true,
          consent_at: new Date().toISOString(),
          user_agent: req.headers.get("user-agent") ?? null,
          utm: body?.utm ?? null,
        },
        { onConflict: "email" }
      );

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "Bad request" }, { status: 400 });
  }
}