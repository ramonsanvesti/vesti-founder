import dynamic from "next/dynamic";

export const dynamic = "force-dynamic";

const WardrobeClient = dynamic(() => import("./WardrobeClient"), {
  ssr: false,
});

export default function WardrobePage() {
  return <WardrobeClient />;
}
