import { Suspense } from "react";
import WardrobeClient from "./WardrobeClient";

export const dynamic = "force-dynamic";

export default function WardrobePage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-muted">Loading wardrobe…</div>}>
      <WardrobeClient />
    </Suspense>
  );
}