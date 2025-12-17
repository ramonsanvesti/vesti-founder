// lib/cse.ts
import "server-only";

export type CseImageCandidate = {
  link: string;
  title?: string;
  contextLink?: string;
  mime?: string;
  width?: number;
  height?: number;
  thumbnailLink?: string;
};

function toNum(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function isLikelyBad(link: string, mime?: string) {
  const l = link.toLowerCase();
  if (!l.startsWith("http")) return true;
  if (l.includes("data:")) return true;
  if (l.endsWith(".svg")) return true;
  if (mime?.includes("svg")) return true;
  // evita trackers o cosas raras muy comunes
  if (l.includes("doubleclick") || l.includes("googleads")) return true;
  return false;
}

/**
 * Scoring simple:
 * - penaliza SVG / no-https / links raros
 * - premia imágenes grandes (si Google trae width/height)
 * - premia thumbnails disponibles (suele ser señal de imagen válida)
 */
function scoreCandidate(c: CseImageCandidate): number {
  if (isLikelyBad(c.link, c.mime)) return -9999;

  let score = 0;

  if (c.link.startsWith("https://")) score += 5;
  if (c.thumbnailLink) score += 2;

  const w = c.width ?? 0;
  const h = c.height ?? 0;

  // tamaño ideal: 600px+
  if (w >= 1200) score += 6;
  else if (w >= 800) score += 5;
  else if (w >= 600) score += 4;
  else if (w >= 400) score += 2;
  else score -= 1;

  if (h >= 600) score += 2;

  // preferir formatos típicos
  const l = c.link.toLowerCase();
  if (l.endsWith(".jpg") || l.endsWith(".jpeg")) score += 2;
  if (l.endsWith(".png")) score += 1;
  if (l.endsWith(".webp")) score += 1;

  return score;
}

export async function searchBestImageFromCSE(query: string): Promise<{
  best: CseImageCandidate | null;
  candidates: CseImageCandidate[];
  raw: any;
}> {
  const apiKey = process.env.GOOGLE_CSE_API_KEY;
  const cx = process.env.GOOGLE_CSE_CX;

  if (!apiKey) throw new Error("GOOGLE_CSE_API_KEY is missing");
  if (!cx) throw new Error("GOOGLE_CSE_CX is missing");

  const q = query.trim();
  if (!q) throw new Error("query is empty");

  // Custom Search JSON API
  // searchType=image = resultados de imágenes
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", q);
  url.searchParams.set("searchType", "image");
  url.searchParams.set("num", "8");
  url.searchParams.set("safe", "off");

  // pedimos fields para reducir payload (si algo falla, igual funciona sin fields)
  url.searchParams.set(
    "fields",
    "items(link,title,image/contextLink,image/thumbnailLink,image/width,image/height,mime),searchInformation"
  );

  const res = await fetch(url.toString(), { method: "GET" });
  const raw = await res.json().catch(() => null);

  if (!res.ok) {
    const msg =
      raw?.error?.message ||
      `CSE request failed: ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }

  const items = Array.isArray(raw?.items) ? raw.items : [];
  const candidates: CseImageCandidate[] = items
    .map((it: any) => {
      const link = String(it?.link ?? "").trim();
      const img = it?.image ?? {};
      return {
        link,
        title: typeof it?.title === "string" ? it.title : undefined,
        contextLink:
          typeof img?.contextLink === "string" ? img.contextLink : undefined,
        thumbnailLink:
          typeof img?.thumbnailLink === "string" ? img.thumbnailLink : undefined,
        width: toNum(img?.width),
        height: toNum(img?.height),
        mime: typeof it?.mime === "string" ? it.mime : undefined,
      };
    })
    .filter((c: CseImageCandidate) => c.link && !isLikelyBad(c.link, c.mime));

  if (candidates.length === 0) {
    return { best: null, candidates: [], raw };
  }

  const sorted = [...candidates].sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  return { best: sorted[0] ?? null, candidates: sorted, raw };
}