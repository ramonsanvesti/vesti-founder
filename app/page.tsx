// app/page.tsx
"use client";
export const dynamic = "force-static";

import { useMemo, useState } from "react";

export default function Page() {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [intent, setIntent] = useState("");
  const [consent, setConsent] = useState(true);
  const [company, setCompany] = useState(""); // honeypot

  const canSubmit = useMemo(() => {
    if (status === "loading") return false;

    const e = email.trim();
    const emailOk = e.length > 3 && e.includes("@") && e.includes(".");

    return emailOk && consent;
  }, [email, status, consent]);

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
          intent,
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
      setIntent("");
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
        {/* Top anchor */}
        <div id="top" className="scroll-mt-28" />

        {/* Nav */}
        <nav className="sticky top-0 z-20 -mx-6 mb-10 border-b border-[#2A1B12]/10 bg-[#F2E0C9]/80 px-6 py-4 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <a
              href="#top"
              className="text-xs font-semibold uppercase tracking-[0.22em] text-[#6B4A34] transition hover:text-[#2A1B12]"
            >
              DRESZI
            </a>

            <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-[#6B4A34]">
              <a className="transition hover:text-[#2A1B12]" href="#how">How it works</a>
              <a className="transition hover:text-[#2A1B12]" href="#for">Who it’s for</a>
              <a className="transition hover:text-[#2A1B12]" href="#manifesto">Manifesto</a>
              <a className="transition hover:text-[#2A1B12]" href="#beta">Beta</a>
              <a className="transition hover:text-[#2A1B12]" href="#request-access">Request</a>
              <a className="transition hover:text-[#2A1B12]" href="#investors">Investors</a>
              <a className="transition hover:text-[#2A1B12]" href="#faq">FAQ</a>
            </div>
          </div>
        </nav>

        {/* Hero */}
        <header className="space-y-6">
          <p className="text-xs uppercase tracking-[0.22em] text-[#6B4A34]">DRESZI</p>
          <h1 className="text-4xl font-semibold leading-tight md:text-5xl">
            Dress better.
            <br />
            Think less.
          </h1>
          <p className="text-lg leading-relaxed text-[#3B2418]">
            Personal style intelligence that learns your wardrobe and your rhythm, then gives you clear outfits in seconds.
          </p>

          <ul className="grid gap-2 text-sm leading-relaxed text-[#3B2418]">
            <li>Outfits that match your day</li>
            <li>Less decision fatigue</li>
            <li>More consistency in how you show up</li>
          </ul>

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

        {/* How it works */}
        <section id="how" className="mt-14 space-y-6 scroll-mt-28">
          <h2 className="text-xl font-semibold tracking-tight">How it works</h2>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-[#2A1B12]/10 bg-white/40 p-5 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-[#6B4A34]">Step 1</p>
              <p className="mt-2 text-sm leading-relaxed text-[#3B2418]">
                Capture your wardrobe with photos or a short video.
              </p>
            </div>

            <div className="rounded-2xl border border-[#2A1B12]/10 bg-white/40 p-5 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-[#6B4A34]">Step 2</p>
              <p className="mt-2 text-sm leading-relaxed text-[#3B2418]">
                DRESZI learns patterns over time. Colors, silhouettes, and the rhythm of your days.
              </p>
            </div>

            <div className="rounded-2xl border border-[#2A1B12]/10 bg-white/40 p-5 shadow-sm">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-[#6B4A34]">Step 3</p>
              <p className="mt-2 text-sm leading-relaxed text-[#3B2418]">
                You get outfits based on context. Weather, time, occasion, energy.
              </p>
            </div>
          </div>
        </section>

        {/* Who it is for */}
        <section id="for" className="mt-14 space-y-6 scroll-mt-28">
          <h2 className="text-xl font-semibold tracking-tight">Who it is for</h2>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-[#2A1B12]/10 bg-white/40 p-5 shadow-sm">
              <p className="text-sm font-semibold text-[#2A1B12]">People who want ease</p>
              <p className="mt-2 text-sm leading-relaxed text-[#3B2418]">If getting dressed feels like friction, DRESZI gives you clarity fast.</p>
            </div>

            <div className="rounded-2xl border border-[#2A1B12]/10 bg-white/40 p-5 shadow-sm">
              <p className="text-sm font-semibold text-[#2A1B12]">Professionals building a silhouette</p>
              <p className="mt-2 text-sm leading-relaxed text-[#3B2418]">Consistency in how you show up, without overthinking.</p>
            </div>

            <div className="rounded-2xl border border-[#2A1B12]/10 bg-white/40 p-5 shadow-sm">
              <p className="text-sm font-semibold text-[#2A1B12]">Anyone tired of more options</p>
              <p className="mt-2 text-sm leading-relaxed text-[#3B2418]">Less noise. More intentional choices from what you already own.</p>
            </div>
          </div>
        </section>

        {/* Manifesto */}
        <section id="manifesto" className="mt-16 space-y-6 scroll-mt-28">
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

        {/* Beta */}
        <section id="beta" className="mt-16 space-y-6 scroll-mt-28">
          <h2 className="text-xl font-semibold tracking-tight">What you get in the beta</h2>

          <div className="rounded-2xl border border-[#2A1B12]/10 bg-white/40 p-6 shadow-sm">
            <ul className="grid gap-2 text-sm leading-relaxed text-[#3B2418]">
              <li>Early access to the core wardrobe capture flow</li>
              <li>Outfit recommendations based on your real closet</li>
              <li>A short onboarding to learn your preferences</li>
              <li>Direct feedback loop with the founder</li>
              <li>Light updates only when something changes</li>
            </ul>
          </div>
        </section>

        {/* CTA */}
        <section
          id="request-access"
          className="mt-16 scroll-mt-28 rounded-2xl border border-[#2A1B12]/10 bg-white/40 p-6 shadow-sm"
        >
          <div className="space-y-2">
            <h2 className="text-xl font-semibold tracking-tight">Request access</h2>
            <p className="text-sm leading-relaxed text-[#3B2418]">
              Leave your email and we’ll reach out when the beta opens. No noise. Just access.
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

              <label className="grid gap-1">
                <span className="text-xs font-medium text-[#6B4A34]">What do you want DRESZI to help you with? (optional)</span>
                <select
                  name="intent"
                  value={intent}
                  onChange={(e) => setIntent(e.target.value)}
                  className="w-full rounded-xl border border-[#2A1B12]/15 bg-white/70 px-4 py-3 text-sm outline-none transition focus:border-[#2A1B12]/30"
                >
                  <option value="">Select one</option>
                  <option value="work_outfits">Work outfits</option>
                  <option value="weekends">Weekends</option>
                  <option value="travel">Travel</option>
                  <option value="minimal_wardrobe">Minimal wardrobe</option>
                  <option value="less_decisions">Less decisions</option>
                </select>
              </label>

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
                  I agree to be contacted about early access and product updates.
                </span>
              </label>

              {!consent && (
                <p className="text-xs text-[#6B4A34]">
                  Consent is required so we can invite you to the beta.
                </p>
              )}

              {status === "error" && (
                <p className="text-sm text-[#3B2418]">{errorMsg}</p>
              )}

              <button
                type="submit"
                disabled={!canSubmit}
                className="mt-1 inline-flex items-center justify-center rounded-xl bg-[#2A1B12] px-6 py-3 text-sm font-semibold text-[#F2E0C9] shadow-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {status === "loading" ? "Sending…" : "Submit"}
              </button>

              <div className="pt-3 space-y-1 text-xs text-[#6B4A34]">
                <p>
                  Contact: <a className="underline" href="mailto:hello@dresz.io">hello@dresz.io</a>
                </p>
                <p>
                  For investors: request the deck and roadmap at <a className="underline" href="mailto:hello@dresz.io?subject=DRESZI%20Investor%20Info">hello@dresz.io</a>
                </p>
              </div>
            </form>
          ) : (
            <div className="mt-6 rounded-2xl border border-[#2A1B12]/10 bg-white/50 p-6">
              <p className="text-lg font-semibold text-[#2A1B12]">You’re in.</p>
              <p className="mt-2 text-sm leading-relaxed text-[#3B2418]">
                We’ll reach out when your early access is ready.
                <br />
                Quick favor: if you don’t see us, check Promotions or Spam and mark us as <span className="font-medium">Not spam</span> so DRESZI can actually reach you.
                <br />
                We will never sell your email.
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

        {/* Investor CTA */}
        <section id="investors" className="mt-16 scroll-mt-28">
          <div className="rounded-2xl border border-[#2A1B12]/10 bg-white/40 p-6 shadow-sm">
            <h2 className="text-xl font-semibold tracking-tight">For investors</h2>
            <p className="mt-2 text-sm leading-relaxed text-[#3B2418]">
              If you want the product thesis, deck, and roadmap, email us.
            </p>
            <div className="mt-4">
              <a
                className="inline-flex items-center justify-center rounded-full bg-[#2A1B12] px-6 py-3 text-sm font-semibold text-[#F2E0C9] shadow-sm transition hover:opacity-95"
                href="mailto:hello@dresz.io?subject=DRESZI%20Investor%20Info"
              >
                Request the deck
              </a>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="mt-16 space-y-6 scroll-mt-28">
          <h2 className="text-xl font-semibold tracking-tight">FAQ</h2>

          <div className="space-y-4">
            <div className="rounded-2xl border border-[#2A1B12]/10 bg-white/40 p-6 shadow-sm">
              <p className="text-sm font-semibold text-[#2A1B12]">Is this a shopping app?</p>
              <p className="mt-2 text-sm leading-relaxed text-[#3B2418]">No. DRESZI starts with what you already own. Clarity first.</p>
            </div>

            <div className="rounded-2xl border border-[#2A1B12]/10 bg-white/40 p-6 shadow-sm">
              <p className="text-sm font-semibold text-[#2A1B12]">Do I need new clothes?</p>
              <p className="mt-2 text-sm leading-relaxed text-[#3B2418]">Not for the beta. The goal is better outfits, not more items.</p>
            </div>

            <div className="rounded-2xl border border-[#2A1B12]/10 bg-white/40 p-6 shadow-sm">
              <p className="text-sm font-semibold text-[#2A1B12]">When does the beta start?</p>
              <p className="mt-2 text-sm leading-relaxed text-[#3B2418]">Rolling invites. Friends and family first, then wider access.</p>
            </div>

            <div className="rounded-2xl border border-[#2A1B12]/10 bg-white/40 p-6 shadow-sm">
              <p className="text-sm font-semibold text-[#2A1B12]">What do you do with my data?</p>
              <p className="mt-2 text-sm leading-relaxed text-[#3B2418]">We only use your email to contact you about access and updates. We will never sell your email.</p>
            </div>
          </div>
        </section>

        <footer className="mt-14 border-t border-[#2A1B12]/10 pt-8 text-xs text-[#6B4A34]">
          © {new Date().getFullYear()} DRESZI. All rights reserved.
          <span className="block pt-2">Built in Austin.</span>
        </footer>
      </div>
    </main>
  );
}