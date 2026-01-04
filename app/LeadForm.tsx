"use client";

import { useMemo, useState } from "react";

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default function LeadForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(true);

  // honeypot
  const [company, setCompany] = useState("");

  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [error, setError] = useState<string>("");

  const utm = useMemo(() => {
    if (typeof window === "undefined") return null;
    const p = new URLSearchParams(window.location.search);
    const out: Record<string, string> = {};
    const map: Record<string, string> = {
      utm_source: "source",
      utm_medium: "medium",
      utm_campaign: "campaign",
      utm_term: "term",
      utm_content: "content",
    };
    Object.entries(map).forEach(([k, v]) => {
      const val = p.get(k);
      if (val) out[v] = val;
    });
    return Object.keys(out).length ? out : null;
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !isValidEmail(cleanEmail)) {
      setStatus("error");
      setError("Please enter a valid email.");
      return;
    }
    if (!consent) {
      setStatus("error");
      setError("Consent is required.");
      return;
    }

    setStatus("loading");
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: cleanEmail,
          name: name.trim() || null,
          consent: true,
          company, // honeypot
          utm,
        }),
      });

      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Something went wrong");
      }

      setStatus("success");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-8 grid gap-4">
      <div className="grid gap-2">
        <label className="text-sm font-medium text-[#402516]">Name (optional)</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-12 rounded-xl border border-[#402516]/20 bg-white/60 px-4 text-[#402516] outline-none ring-0 placeholder:text-[#402516]/45 focus:border-[#8C5F37]/60"
          placeholder="Your name"
          autoComplete="name"
        />
      </div>

      <div className="grid gap-2">
        <label className="text-sm font-medium text-[#402516]">Email</label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-12 rounded-xl border border-[#402516]/20 bg-white/60 px-4 text-[#402516] outline-none ring-0 placeholder:text-[#402516]/45 focus:border-[#8C5F37]/60"
          placeholder="you@domain.com"
          inputMode="email"
          autoComplete="email"
          required
        />
      </div>

      {/* Honeypot (hidden from humans) */}
      <div className="hidden">
        <label>Company</label>
        <input value={company} onChange={(e) => setCompany(e.target.value)} />
      </div>

      <label className="flex items-start gap-3 text-sm text-[#402516]/80">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-1 h-4 w-4 accent-[#8C5F37]"
        />
        I agree to receive product updates from DRESZI.
      </label>

      <button
        type="submit"
        disabled={status === "loading"}
        className="inline-flex h-12 items-center justify-center rounded-full bg-[#8C5F37] px-6 text-sm font-medium text-[#F2E0C9] transition hover:bg-[#734327] disabled:opacity-60"
      >
        {status === "loading" ? "Submitting…" : "Request access"}
      </button>

      {status === "success" ? (
        <p className="text-sm font-medium text-[#402516]">
          You’re on the list. We’ll reach out soon.
        </p>
      ) : null}

      {status === "error" ? <p className="text-sm font-medium text-red-700">{error}</p> : null}
    </form>
  );
}