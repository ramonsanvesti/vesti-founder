// app/api/outfits/generate/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";
import type { VestiCategory } from "@/lib/category";

// ---------- Types ----------
type UseCase =
  | "casual"
  | "streetwear"
  | "work"
  | "athletic"
  | "formal"
  | "winter"
  | "summer"
  | "travel"
  | "lounge";

type Fit = "oversized" | "relaxed" | "regular" | "slim";

type GarmentRow = {
  id: string;
  user_id: string;
  image_url: string | null;
  catalog_name: string | null;
  category: VestiCategory | null;
  subcategory: string | null;

  fit: string | null;
  use_case: string | null;
  use_case_tags: string[] | null;

  color: string | null;
  tags: string[] | null;

  created_at?: string;
};

type GenerateRequest = {
  // obligatorio
  use_case: UseCase;

  // opcionales
  count?: number; // cuántos outfits devolver (default 1)
  include_outerwear?: boolean; // default true
  accessories_max?: number; // default 2
  include_fragrance?: boolean; // default true

  // para founder edition (si luego metes auth, cambias esto)
  user_id?: string; // default fake
};

type OutfitPieceKey =
  | "top"
  | "bottom"
  | "shoes"
  | "outerwear"
  | "accessories"
  | "fragrance";

type Outfit = {
  id: string;
  use_case: UseCase;
  confidence: number;
  pieces: {
    top: GarmentRow;
    bottom: GarmentRow;
    shoes: GarmentRow;
    outerwear?: GarmentRow;
    accessories: GarmentRow[];
    fragrance?: GarmentRow;
  };
  reasoning: {
    palette: string;
    fit: string;
    rules_applied: string[];
    picks: Record<OutfitPieceKey, string[]>;
  };
};

// ---------- Helpers ----------
const ALLOWED_USE_CASES: UseCase[] = [
  "casual",
  "streetwear",
  "work",
  "athletic",
  "formal",
  "winter",
  "summer",
  "travel",
  "lounge",
];

function isUseCase(x: any): x is UseCase {
  return typeof x === "string" && (ALLOWED_USE_CASES as string[]).includes(x);
}

function norm(s?: string | null) {
  return (s ?? "")
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function pickRandom<T>(arr: T[], seed: number) {
  if (!arr.length) return null;
  // deterministic-ish: seed shifts the index
  const idx = Math.abs(seed) % arr.length;
  return arr[idx];
}

function useCaseMatches(g: GarmentRow, target: UseCase) {
  const primary = norm(g.use_case);
  if (primary && primary === target) return true;

  const tags = (g.use_case_tags ?? []).map(norm);
  return tags.includes(target);
}

function getFit(g: GarmentRow): Fit {
  const f = norm(g.fit) as Fit;
  if (f === "oversized" || f === "relaxed" || f === "regular" || f === "slim") return f;
  return "regular";
}

function fitCompatible(topFit: Fit, bottomFit: Fit) {
  // regla simple: no extremos
  if (topFit === "oversized") return bottomFit === "relaxed" || bottomFit === "regular";
  if (topFit === "relaxed") return bottomFit === "relaxed" || bottomFit === "regular";
  if (topFit === "regular") return bottomFit === "regular" || bottomFit === "slim";
  if (topFit === "slim") return bottomFit === "slim";
  return true;
}

// Color families (simple v1)
const NEUTRALS = new Set(["black", "white", "gray", "grey", "beige", "cream", "navy", "off white", "offwhite"]);
const EARTH = new Set(["brown", "tan", "olive", "khaki", "stone", "sand"]);

function colorFamily(c: string | null) {
  const x = norm(c);
  if (!x) return "unknown";
  if (NEUTRALS.has(x)) return "neutral";
  if (EARTH.has(x)) return "earth";
  return "color";
}

function paletteOk(items: GarmentRow[]) {
  // max 1 "color" fuerte
  const families = items.map((g) => colorFamily(g.color));
  const strong = families.filter((f) => f === "color").length;
  return strong <= 1;
}

function computeConfidence(outfit: Outfit) {
  // v1 heuristic
  let score = 0.6;

  // use_case coverage
  const all = [
    outfit.pieces.top,
    outfit.pieces.bottom,
    outfit.pieces.shoes,
    outfit.pieces.outerwear,
    ...outfit.pieces.accessories,
    outfit.pieces.fragrance,
  ].filter(Boolean) as GarmentRow[];

  const target = outfit.use_case;
  const matches = all.filter((g) => useCaseMatches(g, target)).length;
  score += Math.min(0.2, (matches / Math.max(3, all.length)) * 0.2);

  // palette
  if (paletteOk(all)) score += 0.1;

  // fit
  const topFit = getFit(outfit.pieces.top);
  const bottomFit = getFit(outfit.pieces.bottom);
  if (fitCompatible(topFit, bottomFit)) score += 0.1;

  return Math.max(0, Math.min(1, score));
}

// ---------- Main generator ----------
function buildOutfit(params: {
  garments: GarmentRow[];
  target: UseCase;
  includeOuterwear: boolean;
  accessoriesMax: number;
  includeFragrance: boolean;
  seed: number;
}): Outfit | null {
  const { garments, target, includeOuterwear, accessoriesMax, includeFragrance, seed } = params;

  const tops = garments.filter((g) => g.category === "tops" && useCaseMatches(g, target));
  const bottoms = garments.filter((g) => g.category === "bottoms" && useCaseMatches(g, target));
  const shoes = garments.filter((g) => g.category === "shoes" && useCaseMatches(g, target));

  // fallback: si no hay suficientes exactos, permitimos casual
  const topsFallback = tops.length ? tops : garments.filter((g) => g.category === "tops" && useCaseMatches(g, "casual"));
  const bottomsFallback = bottoms.length ? bottoms : garments.filter((g) => g.category === "bottoms" && useCaseMatches(g, "casual"));
  const shoesFallback = shoes.length ? shoes : garments.filter((g) => g.category === "shoes" && useCaseMatches(g, "casual"));

  const top = pickRandom(topsFallback, seed + 1);
  if (!top) return null;

  // bottom must fit-match top
  const topFit = getFit(top);
  const bottomCandidates = bottomsFallback.filter((b) => fitCompatible(topFit, getFit(b)));
  const bottom = pickRandom(bottomCandidates, seed + 2);
  if (!bottom) return null;

  // shoes (shoes “manda” pero en v1 lo mantenemos igual target o casual)
  const shoe = pickRandom(shoesFallback, seed + 3);
  if (!shoe) return null;

  // outerwear optional
  let outer: GarmentRow | undefined = undefined;
  if (includeOuterwear) {
    const outerCandidates = garments
      .filter((g) => g.category === "outerwear")
      .filter((g) => useCaseMatches(g, target) || useCaseMatches(g, "casual"));
    const picked = pickRandom(outerCandidates, seed + 4);
    if (picked) outer = picked;
  }

  // accessories (0..N)
  const accessoryCandidates = garments
    .filter((g) => g.category === "accessories")
    .filter((g) => useCaseMatches(g, target) || useCaseMatches(g, "casual"));

  const accessories: GarmentRow[] = [];
  const takeN = Math.max(0, Math.min(2, accessoriesMax));
  for (let i = 0; i < takeN; i++) {
    const pick = pickRandom(accessoryCandidates.filter((a) => !accessories.some((x) => x.id === a.id)), seed + 10 + i);
    if (pick) accessories.push(pick);
  }

  // fragrance optional
  let frag: GarmentRow | undefined = undefined;
  if (includeFragrance) {
    const fragCandidates = garments
      .filter((g) => g.category === "fragrance")
      .filter((g) => useCaseMatches(g, target) || useCaseMatches(g, "casual"));
    const picked = pickRandom(fragCandidates, seed + 30);
    if (picked) frag = picked;
  }

  const allForPalette = [top, bottom, shoe, outer, ...accessories, frag].filter(Boolean) as GarmentRow[];
  const rules: string[] = ["use_case_match", "fit_balance", "palette_limit_strong_color"];
  const palette = paletteOk(allForPalette) ? "ok" : "mixed";

  const outfit: Outfit = {
    id: `outfit_${Date.now()}_${seed}`,
    use_case: target,
    confidence: 0.6,
    pieces: {
      top,
      bottom,
      shoes: shoe,
      ...(outer ? { outerwear: outer } : {}),
      accessories,
      ...(frag ? { fragrance: frag } : {}),
    },
    reasoning: {
      palette,
      fit: `${getFit(top)} top + ${getFit(bottom)} bottom`,
      rules_applied: rules,
      picks: {
        top: topsFallback.map((x) => x.id),
        bottom: bottomCandidates.map((x) => x.id),
        shoes: shoesFallback.map((x) => x.id),
        outerwear: includeOuterwear
          ? garments.filter((g) => g.category === "outerwear").map((x) => x.id)
          : [],
        accessories: accessoryCandidates.map((x) => x.id),
        fragrance: includeFragrance
          ? garments.filter((g) => g.category === "fragrance").map((x) => x.id)
          : [],
      },
    },
  };

  outfit.confidence = computeConfidence(outfit);

  // En v1 si palette falla, igual devolvemos (pero con confidence menor)
  if (!paletteOk(allForPalette)) {
    outfit.confidence = Math.max(0, outfit.confidence - 0.12);
  }

  return outfit;
}

// ---------- Handler ----------
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<GenerateRequest>;

    const target = body?.use_case;
    if (!isUseCase(target)) {
      return NextResponse.json(
        { error: "Invalid or missing use_case", details: { allowed: ALLOWED_USE_CASES } },
        { status: 400 }
      );
    }

    const count = Math.max(1, Math.min(10, Number(body?.count ?? 1)));
    const includeOuterwear = body?.include_outerwear !== false;
    const includeFragrance = body?.include_fragrance !== false;
    const accessoriesMax = Math.max(0, Math.min(2, Number(body?.accessories_max ?? 2)));

    // Founder Edition: fake user id (luego lo reemplazas con auth.uid())
    const userId = (body?.user_id ?? "00000000-0000-0000-0000-000000000001").toString();

    const supabase = getSupabaseServerClient();

    // Traemos SOLO lo que necesitamos (reduce payload)
    const { data, error } = await supabase
      .from("garments")
      .select(
        "id,user_id,image_url,catalog_name,category,subcategory,fit,use_case,use_case_tags,color,tags,created_at"
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json(
        { error: "Failed to load garments", details: error.message },
        { status: 500 }
      );
    }

    const garments = (data ?? []) as GarmentRow[];

    // hard requirement: must have top/bottom/shoes in some way
    if (garments.length === 0) {
      return NextResponse.json(
        { error: "No garments found for user", details: { user_id: userId } },
        { status: 404 }
      );
    }

    const outfits: Outfit[] = [];
    for (let i = 0; i < count; i++) {
      const seed = Date.now() + i * 97;

      const o = buildOutfit({
        garments,
        target,
        includeOuterwear,
        includeFragrance,
        accessoriesMax,
        seed,
      });

      if (o) outfits.push(o);
    }

    if (outfits.length === 0) {
      return NextResponse.json(
        {
          error: "Not enough pieces to generate an outfit",
          details: {
            required: ["tops", "bottoms", "shoes"],
            hint: "Add at least 1 top, 1 bottom, 1 shoe tagged for the target use_case (or casual fallback).",
          },
        },
        { status: 422 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        use_case: target,
        count: outfits.length,
        outfits,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("Error in /api/outfits/generate:", err);
    return NextResponse.json(
      { error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}