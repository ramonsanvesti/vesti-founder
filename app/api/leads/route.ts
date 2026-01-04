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

function coerceConsent(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (!s) return false;
    return s === "true" || s === "1" || s === "yes" || s === "y" || s === "on";
  }
  return Boolean(v);
}

async function readBody(req: Request): Promise<LeadPayload> {
  const ct = req.headers.get("content-type") ?? "";

  // JSON
  if (ct.includes("application/json")) {
    try {
      return (await req.json()) as LeadPayload;
    } catch {
      return {};
    }
  }

  // HTML form
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    try {
      const fd = await req.formData();

      // Optional: hidden input "utm" with JSON string
      const utmRaw = fd.get("utm");
      let utm: unknown = null;
      if (typeof utmRaw === "string" && utmRaw.trim()) {
        try {
          utm = JSON.parse(utmRaw);
        } catch {
          utm = null;
        }
      }

      return {
        email: fd.get("email"),
        name: fd.get("name"),
        consent: fd.get("consent"),
        company: fd.get("company"),
        utm,
      };
    } catch {
      return {};
    }
  }

  return {};
}

export async function POST(req: Request) {
  try {
    const body = await readBody(req);

    const email = String(body?.email ?? "").trim().toLowerCase();
    const name = String(body?.name ?? "").trim();
    const consent = coerceConsent(body?.consent ?? true);

    // Honeypot (campo invisible en UI). Si viene lleno, es bot.
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