import RequestAccessForm from "./request-access-form";

export const metadata = {
  title: "Request Access · DRESZI",
};

export default function RequestAccessPage() {
  return (
    <div className="min-h-screen" style={{ backgroundColor: "#F2E0C9" }}>
      <div className="mx-auto max-w-2xl px-6 py-16">
        <div className="rounded-3xl border border-black/10 bg-white/55 p-8 shadow-sm backdrop-blur">
          <h1 className="text-3xl font-semibold tracking-tight text-[#402516]">
            Request access
          </h1>
          <p className="mt-3 text-base leading-7 text-[#734327]">
            Early access is limited. Drop your email and we’ll reach out.
          </p>

          <div className="mt-8">
            <RequestAccessForm />
          </div>

          <p className="mt-6 text-sm text-[#734327]/80">
            Contact: <a className="underline" href="mailto:hello@dresz.io">hello@dresz.io</a>
          </p>
        </div>
      </div>
    </div>
  );
}