export default function Home() {
  return (
    <div className="min-h-screen bg-[#F2E0C9] px-6 py-16 text-[#402516]">
      <main className="mx-auto w-full max-w-4xl">
        {/* HERO */}
        <section className="rounded-2xl border border-[#402516]/15 bg-[#F2E0C9] p-8 shadow-sm sm:p-12">
          <div className="flex flex-col gap-8">
            <header className="flex flex-col gap-4">
              <p className="inline-flex w-fit items-center rounded-full border border-[#402516]/20 bg-white/30 px-4 py-1 text-sm tracking-wide">
                DRESZI • personal style intelligence system
              </p>
              <h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
                Dress better.
                <span className="text-[#734327]"> Think less.</span>
              </h1>
              <p className="max-w-2xl text-pretty text-lg leading-8 text-[#402516]/85 sm:text-xl">
                DRESZI is a personal style intelligence system. A guide that brings clarity, intention,
                and calm to the daily ritual of getting dressed.
              </p>
            </header>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <a
                href="mailto:hello@dresz.io?subject=DRESZI%20-%20Hello"
                className="inline-flex h-12 items-center justify-center rounded-full bg-[#402516] px-6 text-sm font-medium text-[#F2E0C9] transition hover:bg-[#734327]"
              >
                Contact hello@dresz.io
              </a>
              <a
                href="#manifesto"
                className="inline-flex h-12 items-center justify-center rounded-full border border-[#402516]/25 bg-white/30 px-6 text-sm font-medium transition hover:bg-white/40"
              >
                Read the manifesto
              </a>
            </div>

            {/* Palette accents */}
            <div className="flex items-center gap-3 pt-2" aria-label="Brand palette">
              <span className="h-3 w-10 rounded-full" style={{ background: "#BF9969" }} />
              <span className="h-3 w-10 rounded-full" style={{ background: "#F2E0C9" }} />
              <span className="h-3 w-10 rounded-full" style={{ background: "#8C5F37" }} />
              <span className="h-3 w-10 rounded-full" style={{ background: "#734327" }} />
              <span className="h-3 w-10 rounded-full" style={{ background: "#402516" }} />
            </div>
          </div>
        </section>

        {/* MANIFESTO */}
        <section id="manifesto" className="mt-10 rounded-2xl border border-[#402516]/10 bg-white/30 p-8 sm:p-12">
          <div className="max-w-3xl">
            <h2 className="text-2xl font-semibold tracking-tight">Manifesto</h2>

            <div className="mt-6 space-y-5 text-base leading-8 text-[#402516]/90 sm:text-lg">
              <p>
                It is not a stylist. Not a store. Not a trend machine.
              </p>
              <p>
                It is a companion that understands the person deeply enough to help them dress with ease and
                purpose. A clarity engine disguised as a wardrobe assistant. A philosophy translated into software.
              </p>
              <p>
                DRESZI learns the user the way a quiet observer learns a character. Through patterns, preferences,
                habits, rituals, silhouettes, colors, and the rhythm of daily life.
              </p>
              <p className="font-medium">
                It exists so the user can dress better and think less.
              </p>
            </div>

            <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
              <a
                href="mailto:hello@dresz.io?subject=DRESZI%20-%20Access%20Request"
                className="inline-flex h-12 items-center justify-center rounded-full bg-[#8C5F37] px-6 text-sm font-medium text-[#F2E0C9] transition hover:bg-[#734327]"
              >
                Request access
              </a>
              <p className="text-sm text-[#402516]/70">
                Version: v0.1.1-beta.1
              </p>
            </div>
          </div>
        </section>

        {/* FOOTER */}
        <footer className="mt-12 flex flex-col items-start justify-between gap-4 border-t border-[#402516]/10 pt-8 text-sm text-[#402516]/70 sm:flex-row sm:items-center">
          <p>© {new Date().getFullYear()} DRESZI</p>
          <p>
            Contact: <a className="font-medium text-[#402516] hover:underline" href="mailto:hello@dresz.io">hello@dresz.io</a>
          </p>
        </footer>
      </main>
    </div>
  );
}
