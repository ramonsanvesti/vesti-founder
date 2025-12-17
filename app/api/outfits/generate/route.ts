// app/api/outfits/generate/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";

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

type GarmentRow = {
  id: string;
  user_id: string | null;

  image_url: string | null;
  catalog_name: string | null;

  category: string | null; // tops, bottoms, outerwear, shoes, accessories, fragrance
  subcategory: string | null;

  tags: string[] | null; // text[]
  fit: string | null; // text
  use_case: string | null; // text
  use_case_tags: string[] | null; // text[]

  color: string | null;
  material: string | null;

  created_at?: string;
};

type OutfitSlot = "top" | "bottom" | "shoes" | "outerwear" | "accessory" | "fragrance";

type GenerateRequestBody = {
  use_case?: UseCase;
  include_accessory?: boolean; // default true
  include_fragrance?: boolean; // default false
  seed_outfit_id?: string | null; // used for regenerate
  exclude_ids?: unknown; // array-like, but we sanitize
};

type PickedItem = {
  slot: OutfitSlot;
  garment: GarmentRow;
  reason: string; // human readable
  score: number;
};

function norm(s: string) {
  return s.toLowerCase().trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function asStringArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(isString).map((x) => x.trim()).filter(Boolean);
  return [];
}

function uniqStrings(arr: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of arr) {
    const s = a.trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function safeTags(g: GarmentRow): string[] {
  return Array.isArray(g.tags) ? g.tags.filter(isString).map(norm).filter(Boolean) : [];
}

function safeUseCaseTags(g: GarmentRow): string[] {
  return Array.isArray(g.use_case_tags)
    ? g.use_case_tags.filter(isString).map(norm).filter(Boolean)
    : [];
}

function displayName(g: GarmentRow): string {
  return g.catalog_name?.trim() || "Unknown Item";
}

function isHeadwear(g: GarmentRow): boolean {
  const blob = `${norm(g.subcategory ?? "")} ${safeTags(g).join(" ")}`;
  return (
    blob.includes("beanie") ||
    blob.includes("cap") ||
    blob.includes("hat") ||
    blob.includes("headwear")
  );
}

function scoreGarment(g: GarmentRow, targetUseCase: UseCase, slot: OutfitSlot): { score: number; reasonBits: string[] } {
  const reasonBits: string[] = [];
  let score = 0;

  const fit = norm(g.fit ?? "");
  const gUseCase = norm(g.use_case ?? "");
  const uct = safeUseCaseTags(g);
  const tags = safeTags(g);
  const blob = `${displayName(g)} ${gUseCase} ${fit} ${tags.join(" ")} ${uct.join(" ")}`.toLowerCase();

  // Strong match: explicit use_case field
  if (gUseCase === targetUseCase) {
    score += 40;
    reasonBits.push(`Matches use_case "${targetUseCase}"`);
  }

  // Secondary match: use_case_tags contains target
  if (uct.includes(targetUseCase)) {
    score += 25;
    reasonBits.push(`Has use_case_tag "${targetUseCase}"`);
  }

  // Fallback: if not tagged for any use case, do not penalize too much
  if (!gUseCase && uct.length === 0) {
    score += 8;
    reasonBits.push("No use_case data (fallback)");
  }

  // Fit relevance (light weight)
  if (fit) {
    score += 6;
    reasonBits.push(`Fit: ${fit}`);
  }

  // Slot heuristics
  if (slot === "outerwear") {
    if (blob.includes("jacket") || blob.includes("coat") || blob.includes("hoodie") || blob.includes("zip")) score += 8;
    if (targetUseCase === "winter") score += 10;
  }

  if (slot === "shoes") {
    if (blob.includes("sneaker") || blob.includes("shoe") || blob.includes("trainer")) score += 6;
    if (targetUseCase === "athletic" && (blob.includes("running") || blob.includes("training"))) score += 10;
  }

  if (slot === "top") {
    if (blob.includes("tee") || blob.includes("t shirt") || blob.includes("shirt") || blob.includes("crewneck") || blob.includes("sweater"))
      score += 4;
  }

  if (slot === "bottom") {
    if (blob.includes("jean") || blob.includes("denim") || blob.includes("pant") || blob.includes("trouser") || blob.includes("jogger"))
      score += 4;
  }

  if (slot === "accessory") {
    // Accessories are optional; keep weight low and avoid headwear dominance
    score += 2;
    if (isHeadwear(g)) score -= 12; // de-weight headwear so it doesn't appear in every outfit
    if (targetUseCase === "winter" && isHeadwear(g)) score += 3; // still possible, just not guaranteed
  }

  if (slot === "fragrance") {
    score += 1;
    if (blob.includes("parfum") || blob.includes("cologne") || blob.includes("fragrance") || blob.includes("perfume")) score += 10;
  }

  // Small diversity bonus: newer items slightly preferred
  if (g.created_at) score += 1;

  return { score, reasonBits };
}

function pickBest(candidates: GarmentRow[], targetUseCase: UseCase, slot: OutfitSlot): PickedItem | null {
  let best: PickedItem | null = null;

  for (const g of candidates) {
    const { score, reasonBits } = scoreGarment(g, targetUseCase, slot);
    const reason = `${displayName(g)}: ${reasonBits.join(" · ") || "Selected by fallback rules"}`;

    if (!best || score > best.score) {
      best = { slot, garment: g, score, reason };
    }
  }

  return best;
}

/**
 * Loads garment_ids from a previous outfit to auto-exclude them for regenerate.
 * This prevents repeats when the user clicks "Regenerate Variation".
 */
async function loadSeedExclusions(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  seedOutfitId: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from("outfit_items")
    .select("garment_id")
    .eq("outfit_id", seedOutfitId);

  if (error || !data) return [];

  return data
    .map((row: any) => (typeof row?.garment_id === "string" ? row.garment_id : ""))
    .filter(Boolean);
}

function bucketByCategory(garments: GarmentRow[]) {
  const by: Record<string, GarmentRow[]> = {
    tops: [],
    bottoms: [],
    outerwear: [],
    shoes: [],
    accessories: [],
    fragrance: [],
    unknown: [],
  };

  for (const g of garments) {
    const c = norm(g.category ?? "");
    if (c === "tops") by.tops.push(g);
    else if (c === "bottoms") by.bottoms.push(g);
    else if (c === "outerwear") by.outerwear.push(g);
    else if (c === "shoes") by.shoes.push(g);
    else if (c === "accessories") by.accessories.push(g);
    else if (c === "fragrance") by.fragrance.push(g);
    else by.unknown.push(g);
  }
  return by;
}

async function persistOutfit(args: {
  supabase: ReturnType<typeof getSupabaseServerClient>;
  userId: string;
  useCase: UseCase;
  picked: PickedItem[];
  reasoning: string;
  seedOutfitId?: string | null;
}) {
  const { supabase, userId, useCase, picked, reasoning, seedOutfitId } = args;

  // Insert outfit
  const { data: outfit, error: outfitErr } = await supabase
    .from("outfits")
    .insert({
      user_id: userId,
      use_case: useCase,
      seed_outfit_id: seedOutfitId ?? null,
      reasoning,
    })
    .select("*")
    .single();

  if (outfitErr || !outfit) {
    return { outfit: null, error: outfitErr?.message ?? "Failed to save outfit" };
  }

  // Insert items
  const itemsPayload = picked.map((p) => ({
    outfit_id: outfit.id,
    garment_id: p.garment.id,
    slot: p.slot,
    reason: p.reason,
    score: p.score,
  }));

  const { error: itemsErr } = await supabase.from("outfit_items").insert(itemsPayload);

  if (itemsErr) {
    // Outfit exists; items failed. Return outfit anyway so UI can still render.
    return { outfit, error: `Outfit saved but items failed: ${itemsErr.message}` };
  }

  return { outfit, error: null };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as GenerateRequestBody;

    const targetUseCase: UseCase = (body.use_case ?? "casual") as UseCase;
    const includeAccessory = body.include_accessory !== false; // default true
    const includeFragrance = body.include_fragrance === true; // default false

    const supabase = getSupabaseServerClient();

    // Founder Edition fake user_id (replace with auth later)
    const fakeUserId = "00000000-0000-0000-0000-000000000001";

    // Build exclusion set (manual + seed outfit items)
    const manualExclude = uniqStrings(asStringArray(body.exclude_ids));
    const seedExclude = body.seed_outfit_id
      ? await loadSeedExclusions(supabase, String(body.seed_outfit_id))
      : [];
    const excludeSet = new Set<string>([...manualExclude, ...seedExclude]);

    // Pull wardrobe
    const { data: garmentsRaw, error } = await supabase
      .from("garments")
      .select(
        "id,user_id,image_url,catalog_name,category,subcategory,tags,fit,use_case,use_case_tags,color,material,created_at"
      )
      .eq("user_id", fakeUserId)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json(
        { ok: false, error: "Failed to load garments", details: error.message },
        { status: 500 }
      );
    }

    const garments = (garmentsRaw ?? []) as GarmentRow[];

    // Filter exclusions
    const wardrobe = garments.filter((g) => g?.id && !excludeSet.has(g.id));

    const by = bucketByCategory(wardrobe);

    // Minimum required: top + bottom + shoes
    // Intelligent fallback: if category buckets are empty but we have unknown, try to reuse unknown.
    const topsPool = by.tops.length ? by.tops : by.unknown;
    const bottomsPool = by.bottoms.length ? by.bottoms : by.unknown;
    const shoesPool = by.shoes.length ? by.shoes : by.unknown;

    if (!topsPool.length || !bottomsPool.length || !shoesPool.length) {
      const missing = [
        !topsPool.length ? "tops" : null,
        !bottomsPool.length ? "bottoms" : null,
        !shoesPool.length ? "shoes" : null,
      ].filter(Boolean);

      return NextResponse.json(
        {
          ok: false,
          error: "No outfit generated",
          details: `Missing required categories: ${missing.join(", ")}`,
          counts: {
            tops: by.tops.length,
            bottoms: by.bottoms.length,
            shoes: by.shoes.length,
            outerwear: by.outerwear.length,
            accessories: by.accessories.length,
            fragrance: by.fragrance.length,
            unknown: by.unknown.length,
          },
        },
        { status: 400 }
      );
    }

    const picked: PickedItem[] = [];

    const topPick = pickBest(topsPool, targetUseCase, "top");
    const bottomPick = pickBest(bottomsPool, targetUseCase, "bottom");
    const shoesPick = pickBest(shoesPool, targetUseCase, "shoes");

    if (!topPick || !bottomPick || !shoesPick) {
      return NextResponse.json(
        { ok: false, error: "No outfit generated", details: "Could not pick required pieces." },
        { status: 400 }
      );
    }

    picked.push(topPick, bottomPick, shoesPick);

    // Optional outerwear: prefer in winter/work/travel or if wardrobe has plenty
    const shouldAddOuterwear =
      targetUseCase === "winter" ||
      targetUseCase === "work" ||
      targetUseCase === "travel" ||
      by.outerwear.length >= 3;

    if (shouldAddOuterwear && by.outerwear.length > 0) {
      // Avoid picking an outerwear that is basically the same item as the top (rare, but helpful)
      const outerPick = pickBest(by.outerwear, targetUseCase, "outerwear");
      if (outerPick) picked.push(outerPick);
    }

    // Optional accessory: controlled and de-weight headwear so it doesn't show up everywhere
    if (includeAccessory && by.accessories.length > 0) {
      // If winter, allow accessories but do not force headwear
      // Also: only one accessory max in v1
      const accessoryPick = pickBest(by.accessories, targetUseCase, "accessory");
      if (accessoryPick && accessoryPick.score >= 0) picked.push(accessoryPick);
    }

    // Optional fragrance: only if explicitly enabled
    if (includeFragrance && by.fragrance.length > 0) {
      const fragPick = pickBest(by.fragrance, targetUseCase, "fragrance");
      if (fragPick) picked.push(fragPick);
    }

    // Build coherent, human reasoning
    const lines: string[] = [];
    lines.push(
      `Rules-based outfit generated for "${targetUseCase}" with diversity controls (auto-exclude on regenerate, accessories optional, headwear de-weighted).`
    );
    for (const p of picked) {
      const cat = norm(p.garment.category ?? "");
      const fit = norm(p.garment.fit ?? "");
      const use = norm(p.garment.use_case ?? "");
      lines.push(
        `• ${p.slot.toUpperCase()}: ${displayName(p.garment)} (${cat || "unknown"}) — use_case: ${use || "n/a"}, fit: ${fit || "n/a"}`
      );
    }

    const reasoning = lines.join("\n");

    // Persist outfit + items for history and regenerate variations
    const { outfit, error: persistError } = await persistOutfit({
      supabase,
      userId: fakeUserId,
      useCase: targetUseCase,
      picked,
      reasoning,
      seedOutfitId: body.seed_outfit_id ?? null,
    });

    // Build exclude_ids for next variation automatically (everything used in this outfit)
    const nextExcludeIds = uniqStrings(picked.map((p) => p.garment.id));

    return NextResponse.json(
      {
        ok: true,
        outfit,
        items: picked.map((p) => ({
          slot: p.slot,
          garment: p.garment,
          reason: p.reason,
          score: p.score,
        })),
        reasoning,
        next_exclude_ids: nextExcludeIds,
        warnings: persistError ? [persistError] : [],
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("Error in /api/outfits/generate:", err);
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}