// app/page.tsx
"use client";
export const dynamic = "force-static";

import { useMemo, useState } from "react";

export default function Page() {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(true);
  const [company, setCompany] = useState(""); // honeypot

  const canSubmit = useMemo(() => {
    if (status === "loading") return false;
    return email.trim().length > 3;
  }, [email, status]);

  async function onRequestAccessSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("loading");
    setErrorMsg(null);

    try {
      const utmParams = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
      const utm = {
        utm_source: utmParams.get("utm_source"),
        utm_medium: utmParams.get("utm_medium"),
        utm_campaign: utmParams.get("utm_campaign"),
        utm_term: utmParams.get("utm_term"),
        utm_content: utmParams.get("utm_content"),
      };

      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          consent,
          company, // honeypot
          utm,
        }),
      });

      const data = (await res.json()) as { ok?: boolean; error?: string };

      if (!res.ok || !data?.ok) {
        setStatus("error");
        setErrorMsg(data?.error || "Something went wrong. Please try again.");
        return;
      }

      setStatus("success");
      setName("");
      setEmail("");
      setConsent(true);
      setCompany("");
    } catch {
      setStatus("error");
      setErrorMsg("Network error. Please try again.");
    }
  }

  return (
    <main className="min-h-screen bg-[#F2E0C9] text-[#2A1B12]">
      <div className="mx-auto max-w-3xl px-6 py-16">
        {/* Hero */}
        <header className="space-y-6">
          <p className="text-xs uppercase tracking-[0.22em] text-[#6B4A34]">DRESZI</p>
          <h1 className="text-4xl font-semibold leading-tight md:text-5xl">
            Personal style intelligence.
            <br />
            Calm, clarity, intention.
          </h1>
          <p className="text-lg leading-relaxed text-[#3B2418]">
            DRESZI is a personal style intelligence system. A guide that brings clarity,
            intention, and calm to the daily ritual of getting dressed.
          </p>

          <div className="flex flex-wrap gap-3 pt-2">
            <a
              href="#request-access"
              className="inline-flex items-center justify-center rounded-full bg-[#2A1B12] px-6 py-3 text-sm font-semibold text-[#F2E0C9] shadow-sm transition hover:opacity-95"
            >
              Request access
            </a>
            <a
              href="#manifesto"
              className="inline-flex items-center justify-center rounded-full border border-[#2A1B12]/20 bg-transparent px-6 py-3 text-sm font-semibold text-[#2A1B12] transition hover:bg-[#2A1B12]/5"
            >
              Read the manifesto
            </a>
          </div>
        </header>

        {/* Manifesto */}
        <section id="manifesto" className="mt-16 space-y-6">
          <h2 className="text-xl font-semibold tracking-tight">Manifesto</h2>
          <div className="space-y-4 text-[15px] leading-relaxed text-[#3B2418]">
            <p>It is not a stylist. Not a store. Not a trend machine.</p>
            <p>
              It is a companion that understands the person deeply enough to help them dress
              with ease and purpose. A clarity engine disguised as a wardrobe assistant. A
              philosophy translated into software.
            </p>
            <p>
              DRESZI learns the user the way a quiet observer learns a character. Through
              patterns, preferences, habits, rituals, silhouettes, colors, and the rhythm of
              daily life.
            </p>
            <p className="font-medium">It exists so the user can dress better and think less.</p>
          </div>
        </section>

        {/* CTA */}
        <section
          id="request-access"
          className="mt-16 rounded-2xl border border-[#2A1B12]/10 bg-white/40 p-6 shadow-sm"
        >
          <div className="space-y-2">
            <h2 className="text-xl font-semibold tracking-tight">Request access</h2>
            <p className="text-sm leading-relaxed text-[#3B2418]">
              Leave your email and we’ll reach out when the beta opens. No spam.
            </p>
          </div>

          {status !== "success" ? (
            <form className="mt-6 grid gap-3" onSubmit={onRequestAccessSubmit}>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-1">
                  <span className="text-xs font-medium text-[#6B4A34]">Name (optional)</span>
                  <input
                    name="name"
                    type="text"
                    placeholder="Your name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full rounded-xl border border-[#2A1B12]/15 bg-white/70 px-4 py-3 text-sm outline-none transition focus:border-[#2A1B12]/30"
                  />
                </label>

                <label className="grid gap-1">
                  <span className="text-xs font-medium text-[#6B4A34]">Email</span>
                  <input
                    name="email"
                    type="email"
                    required
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-xl border border-[#2A1B12]/15 bg-white/70 px-4 py-3 text-sm outline-none transition focus:border-[#2A1B12]/30"
                  />
                </label>
              </div>

              {/* Honeypot */}
              <input
                name="company"
                type="text"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                tabIndex={-1}
                autoComplete="off"
                className="hidden"
                aria-hidden="true"
              />

              <label className="flex items-start gap-3 rounded-xl border border-[#2A1B12]/10 bg-white/40 p-4">
                <input
                  name="consent"
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-1"
                />
                <span className="text-sm text-[#3B2418]">
                  I agree to be contacted about DRESZI updates.
                </span>
              </label>

              {status === "error" && (
                <p className="text-sm text-[#3B2418]">
                  {errorMsg}
                </p>
              )}

              <button
                type="submit"
                disabled={!canSubmit}
                className="mt-1 inline-flex items-center justify-center rounded-xl bg-[#2A1B12] px-6 py-3 text-sm font-semibold text-[#F2E0C9] shadow-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {status === "loading" ? "Sending…" : "Submit"}
              </button>

              <p className="pt-3 text-xs text-[#6B4A34]">
                Contact: <a className="underline" href="mailto:hello@dresz.io">hello@dresz.io</a>
              </p>
            </form>
          ) : (
            <div className="mt-6 rounded-2xl border border-[#2A1B12]/10 bg-white/50 p-6">
              <p className="text-lg font-semibold text-[#2A1B12]">You’re in.</p>
              <p className="mt-2 text-sm leading-relaxed text-[#3B2418]">
                We’ll reach out soon with early access details.
                <br />
                Quick favor: check your inbox and, if you don’t see us, look in Promotions or Spam and mark us as <span className="font-medium">Not spam</span> so DRESZI can actually reach you.
              </p>
              <p className="mt-4 text-xs text-[#6B4A34]">
                No noise. No blasts. Just product updates and access.
              </p>
              <div className="mt-5">
                <button
                  type="button"
                  onClick={() => setStatus("idle")}
                  className="inline-flex items-center justify-center rounded-full border border-[#2A1B12]/20 bg-transparent px-5 py-2 text-xs font-semibold text-[#2A1B12] transition hover:bg-[#2A1B12]/5"
                >
                  Add another email
                </button>
              </div>
            </div>
          )}
        </section>

        <footer className="mt-14 border-t border-[#2A1B12]/10 pt-8 text-xs text-[#6B4A34]">
          © {new Date().getFullYear()} DRESZI. All rights reserved.
        </footer>
      </div>
    </main>
  );
}