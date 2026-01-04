"use client";

import { useMemo, useState } from "react";

export default function RequestAccessForm() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(true);

  // Honeypot: bots lo llenan, humanos no lo ven
  const [company, setCompany] = useState("");

  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");

  const disabled = useMemo(() => status === "loading", [status]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setErrorMsg("");

    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          name,
          consent,
          company, // honeypot
          utm: null, // si luego quieres, aquí parseamos UTM del URL
        }),
      });

      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setStatus("error");
        setErrorMsg(data?.error ?? "Something went wrong.");
        return;
      }

      setStatus("ok");
    } catch {
      setStatus("error");
      setErrorMsg("Network error.");
    }
  }

  if (status === "ok") {
    return (
      <div className="rounded-2xl border border-black/10 bg-white/60 p-6">
        <h2 className="text-xl font-semibold text-[#402516]">You’re in.</h2>
        <p className="mt-2 text-[#734327]">
          We saved your request. You’ll hear from us soon.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-[#402516]">Email</label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          required
          disabled={disabled}
          className="mt-2 w-full rounded-xl border border-black/15 bg-white/70 px-4 py-3 text-[#402516] outline-none focus:border-black/30"
          placeholder="you@domain.com"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-[#402516]">Name (optional)</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          type="text"
          disabled={disabled}
          className="mt-2 w-full rounded-xl border border-black/15 bg-white/70 px-4 py-3 text-[#402516] outline-none focus:border-black/30"
          placeholder="Ramón"
        />
      </div>

      {/* Honeypot hidden */}
      <div className="hidden">
        <label>Company</label>
        <input value={company} onChange={(e) => setCompany(e.target.value)} />
      </div>

      <label className="flex items-start gap-3 text-sm text-[#734327]">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-1"
          required
          disabled={disabled}
        />
        I agree to receive emails about DRESZI updates and early access.
      </label>

      {status === "error" && (
        <p className="text-sm text-red-700">{errorMsg}</p>
      )}

      <button
        type="submit"
        disabled={disabled}
        className="inline-flex w-full items-center justify-center rounded-full px-6 py-3 font-medium text-[#F2E0C9]"
        style={{ backgroundColor: "#402516" }}
      >
        {status === "loading" ? "Submitting..." : "Request access"}
      </button>

      <p className="text-xs text-[#734327]/80">
        We store your email for early access outreach. No spam.
      </p>
    </form>
  );
}