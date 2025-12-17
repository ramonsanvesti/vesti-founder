// app/api/outfits/generate/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";

type VestiCategory = "tops" | "bottoms" | "outerwear" | "shoes" | "accessories" | "fragrance";

type GarmentRow = {
  id: string;
  user_id: string;
  image_url: string | null;
  catalog_name: string | null;
  category: VestiCategory | null;
  subcategory: string | null;

  tags: string[] | null;

  fit: string | null; // oversized | relaxed | slim | regular
  use_case: string | null; // casual | streetwear | work | athletic | winter...
  use_case_tags: string[] | null;

  color: string | null;
  material: string | null;
  brand: string | null;

  created_at?: string;
  updated_at?: string;

  metadata?: any;
};

type GenerateRequest = {
  user_id?: string; // optional (Founder Edition usa fake)
  // Para “regenerate variations” o evitar piezas repetidas
  exclude_ids?: string[];

  // Control simple del look
  use_case?: string; // ej: "casual" | "streetwear" | "work" | "athletic" | "winter"
  include_outerwear?: boolean; // default true si use_case winter
  include_fragrance?: boolean; // default false
  include_accessory?: boolean; // default probabilístico
  accessory_probability?: number; // 0..1, default 0.6

  // Para reproducibilidad simple
  seed?: number;
};

type OutfitItem = {
  garment_id: string;
  category: VestiCategory;
  name: string;
  image_url: string | null;
  tags: string[];
  fit: string | null;
  use_case: string | null;
  reasoning: string;
  accessory_type?: string | null;
};

function norm(s: string) {
  return s.toLowerCase().trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function uniq(arr: string[]) {
  return Array.from(new Set(arr.map((x) => x.trim()).filter(Boolean)));
}

// RNG reproducible
function mulberry32(seed: number) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function getTags(g: GarmentRow): string[] {
  const t = Array.isArray(g.tags) ? g.tags : [];
  return uniq(t.map((x) => norm(String(x))));
}

function inferAccessoryType(g: GarmentRow): string | null {
  const tags = getTags(g);
  const sub = norm(g.subcategory ?? "");
  const blob = `${sub} ${tags.join(" ")}`.trim();

  if (blob.includes("beanie") || blob.includes("hat") || blob.includes("cap") || blob.includes("headwear")) return "headwear";
  if (blob.includes("scarf") || blob.includes("neckwear")) return "neckwear";
  if (blob.includes("watch") || blob.includes("bracelet") || blob.includes("wrist")) return "wristwear";
  if (blob.includes("bag") || blob.includes("backpack") || blob.includes("purse")) return "bag";
  if (blob.includes("belt")) return "belt";
  if (blob.includes("sunglass") || blob.includes("sunglasses") || blob.includes("eyewear")) return "eyewear";
  if (blob.includes("ring") || blob.includes("necklace") || blob.includes("earring") || blob.includes("jewelry")) return "jewelry";

  return "accessory";
}

function matchesUseCase(g: GarmentRow, desired: string | null): boolean {
  if (!desired) return true;
  const d = norm(desired);
  const uc = norm(g.use_case ?? "");
  if (uc && uc === d) return true;
  const tags = (g.use_case_tags ?? []).map((x) => norm(String(x)));
  return tags.includes(d);
}

function scoreGarment(params: {
  garment: GarmentRow;
  desiredUseCase: string | null;
  desiredCategory: VestiCategory;
  rng: () => number;
  usageCount: Map<string, number>;
  usedAccessoryTypes: Set<string>;
}): { score: number; reasoning: string; accessory_type?: string | null } {
  const { garment: g, desiredUseCase, desiredCategory, rng, usageCount, usedAccessoryTypes } = params;

  const tags = getTags(g);
  const name = (g.catalog_name ?? "unknown").trim();
  const uc = norm(g.use_case ?? "");
  const desired = desiredUseCase ? norm(desiredUseCase) : null;

  let score = 0;
  const reasons: string[] = [];

  // Base + noise pequeño
  score += 1 + rng() * 0.25;

  // Match use_case
  if (desired) {
    if (uc === desired) {
      score += 2.5;
      reasons.push(`Matches use_case "${desiredUseCase}"`);
    } else if ((g.use_case_tags ?? []).map((x) => norm(String(x))).includes(desired)) {
      score += 1.5;
      reasons.push(`Related to use_case "${desiredUseCase}"`);
    }
  }

  // Preferencia ligera por piezas con tags ricos
  score += Math.min(tags.length, 12) * 0.08;
  if (tags.length >= 8) reasons.push("Rich tags");

  // Fit signal
  const fit = norm(g.fit ?? "");
  if (fit) {
    score += 0.2;
    reasons.push(`Fit: ${fit}`);
  }

  // Anti repetición (en esta generación)
  const used = usageCount.get(g.id) ?? 0;
  if (used > 0) {
    score -= used * 3;
    reasons.push("Penalized for repetition");
  }

  // --- Reglas especiales para accessories ---
  let accessory_type: string | null | undefined = undefined;

  if (desiredCategory === "accessories") {
    accessory_type = inferAccessoryType(g);

    // Diversidad por tipo
    if (accessory_type && usedAccessoryTypes.has(accessory_type)) {
      score -= 2.5;
      reasons.push(`Penalized: accessory_type "${accessory_type}" already used`);
    }

    // Headwear NO automático por winter
    if (accessory_type === "headwear" && desired === "winter") {
      // 50% de las veces lo bajamos para evitar “siempre beanie”
      if (rng() < 0.5) {
        score -= 2.0;
        reasons.push("Downweighted headwear in winter (avoid beanie spam)");
      } else {
        reasons.push("Allowed headwear for winter (randomized)");
      }
    }
  }

  // Preferir “coherencia” con category (si hay mismatches raros en data)
  if (g.category && g.category !== desiredCategory) {
    score -= 2.0;
    reasons.push("Category mismatch (data)");
  }

  // Sanity: si no tiene image_url, bajamos (para UI)
  if (!g.image_url) {
    score -= 0.75;
    reasons.push("No image_url");
  }

  return {
    score,
    reasoning: `${name}: ${reasons.length ? reasons.join(" · ") : "Selected"}`,
    accessory_type,
  };
}

function pickBest(params: {
  pool: GarmentRow[];
  desiredUseCase: string | null;
  desiredCategory: VestiCategory;
  rng: () => number;
  usageCount: Map<string, number>;
  usedAccessoryTypes: Set<string>;
  excludeIds: Set<string>;
}): { garment: GarmentRow | null; reasoning: string; accessory_type?: string | null } {
  const { pool, desiredUseCase, desiredCategory, rng, usageCount, usedAccessoryTypes, excludeIds } = params;

  const candidates = pool.filter((g) => !excludeIds.has(g.id));
  if (!candidates.length) return { garment: null, reasoning: "No candidates available" };

  let best: GarmentRow | null = null;
  let bestScore = -Infinity;
  let bestReason = "";
  let bestAccType: string | null | undefined = undefined;

  for (const g of candidates) {
    // Hard filter por use_case (suave: si no hay match, igual puede entrar con score bajo)
    const { score, reasoning, accessory_type } = scoreGarment({
      garment: g,
      desiredUseCase,
      desiredCategory,
      rng,
      usageCount,
      usedAccessoryTypes,
    });

    if (score > bestScore) {
      bestScore = score;
      best = g;
      bestReason = reasoning;
      bestAccType = accessory_type;
    }
  }

  return { garment: best, reasoning: bestReason, accessory_type: bestAccType };
}

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseServerClient();

    const body = (await req.json().catch(() => ({}))) as GenerateRequest;

    const fakeUserId = "00000000-0000-0000-0000-000000000001";
    const userId = (body.user_id ?? fakeUserId).trim();

    const desiredUseCase = body.use_case ? String(body.use_case) : null;

    const seed = typeof body.seed === "number" ? body.seed : Date.now();
    const rng = mulberry32(seed);

    const excludeIds = new Set<string>(Array.isArray(body.exclude_ids) ? body.exclude_ids : []);

    // Cargamos todo el closet del user
    const { data, error } = await supabase
      .from("garments")
      .select("id,user_id,image_url,catalog_name,category,subcategory,tags,fit,use_case,use_case_tags,color,material,brand,metadata,created_at,updated_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: "Failed to load garments", details: error.message }, { status: 500 });
    }

    const garments = (data ?? []) as GarmentRow[];

    // Pools por category
    const byCat = (cat: VestiCategory) =>
      garments.filter((g) => g.category === cat);

    const tops = byCat("tops");
    const bottoms = byCat("bottoms");
    const outerwear = byCat("outerwear");
    const shoes = byCat("shoes");
    const accessories = byCat("accessories");
    const fragrance = byCat("fragrance");

    // Guards mínimos
    if (!tops.length || !bottoms.length) {
      return NextResponse.json(
        {
          ok: false,
          error: "Not enough garments to generate an outfit",
          details: {
            tops: tops.length,
            bottoms: bottoms.length,
            outerwear: outerwear.length,
            shoes: shoes.length,
            accessories: accessories.length,
          },
        },
        { status: 400 }
      );
    }

    // Memoria dentro de esta generación
    const usageCount = new Map<string, number>();
    const usedAccessoryTypes = new Set<string>();

    // Helper para “registrar” uso
    const markUsed = (id: string) => {
      usageCount.set(id, (usageCount.get(id) ?? 0) + 1);
      excludeIds.add(id); // evita repetir en el mismo outfit
    };

    // Decide incluir outerwear
    const includeOuterwear =
      typeof body.include_outerwear === "boolean"
        ? body.include_outerwear
        : desiredUseCase ? norm(desiredUseCase) === "winter" : rng() < 0.55;

    // Decide incluir accessory
    const accessoryProbability =
      typeof body.accessory_probability === "number"
        ? Math.max(0, Math.min(1, body.accessory_probability))
        : 0.6;

    const includeAccessory =
      typeof body.include_accessory === "boolean"
        ? body.include_accessory
        : rng() < accessoryProbability;

    // Decide incluir fragancia
    const includeFragrance = !!body.include_fragrance && fragrance.length > 0;

    // --- Picks ---
    const chosen: OutfitItem[] = [];
    const reasoning: string[] = [];

    // TOP
    const pickTop = pickBest({
      pool: tops,
      desiredUseCase,
      desiredCategory: "tops",
      rng,
      usageCount,
      usedAccessoryTypes,
      excludeIds,
    });

    if (!pickTop.garment) {
      return NextResponse.json({ ok: false, error: "Could not pick top" }, { status: 400 });
    }
    markUsed(pickTop.garment.id);
    chosen.push({
      garment_id: pickTop.garment.id,
      category: "tops",
      name: pickTop.garment.catalog_name ?? "Top",
      image_url: pickTop.garment.image_url,
      tags: getTags(pickTop.garment),
      fit: pickTop.garment.fit,
      use_case: pickTop.garment.use_case,
      reasoning: pickTop.reasoning,
    });
    reasoning.push(`Top: ${pickTop.reasoning}`);

    // BOTTOM
    const pickBottom = pickBest({
      pool: bottoms,
      desiredUseCase,
      desiredCategory: "bottoms",
      rng,
      usageCount,
      usedAccessoryTypes,
      excludeIds,
    });

    if (!pickBottom.garment) {
      return NextResponse.json({ ok: false, error: "Could not pick bottoms" }, { status: 400 });
    }
    markUsed(pickBottom.garment.id);
    chosen.push({
      garment_id: pickBottom.garment.id,
      category: "bottoms",
      name: pickBottom.garment.catalog_name ?? "Bottoms",
      image_url: pickBottom.garment.image_url,
      tags: getTags(pickBottom.garment),
      fit: pickBottom.garment.fit,
      use_case: pickBottom.garment.use_case,
      reasoning: pickBottom.reasoning,
    });
    reasoning.push(`Bottoms: ${pickBottom.reasoning}`);

    // SHOES (si hay)
    if (shoes.length) {
      const pickShoes = pickBest({
        pool: shoes,
        desiredUseCase,
        desiredCategory: "shoes",
        rng,
        usageCount,
        usedAccessoryTypes,
        excludeIds,
      });

      if (pickShoes.garment) {
        markUsed(pickShoes.garment.id);
        chosen.push({
          garment_id: pickShoes.garment.id,
          category: "shoes",
          name: pickShoes.garment.catalog_name ?? "Shoes",
          image_url: pickShoes.garment.image_url,
          tags: getTags(pickShoes.garment),
          fit: pickShoes.garment.fit,
          use_case: pickShoes.garment.use_case,
          reasoning: pickShoes.reasoning,
        });
        reasoning.push(`Shoes: ${pickShoes.reasoning}`);
      }
    }

    // OUTERWEAR (opcional)
    if (includeOuterwear && outerwear.length) {
      const pickOuter = pickBest({
        pool: outerwear,
        desiredUseCase,
        desiredCategory: "outerwear",
        rng,
        usageCount,
        usedAccessoryTypes,
        excludeIds,
      });

      if (pickOuter.garment) {
        markUsed(pickOuter.garment.id);
        chosen.push({
          garment_id: pickOuter.garment.id,
          category: "outerwear",
          name: pickOuter.garment.catalog_name ?? "Outerwear",
          image_url: pickOuter.garment.image_url,
          tags: getTags(pickOuter.garment),
          fit: pickOuter.garment.fit,
          use_case: pickOuter.garment.use_case,
          reasoning: pickOuter.reasoning,
        });
        reasoning.push(`Outerwear: ${pickOuter.reasoning}`);
      }
    }

    // ACCESSORY (opcional y con anti-beanie)
    if (includeAccessory && accessories.length) {
      const pickAcc = pickBest({
        pool: accessories,
        desiredUseCase,
        desiredCategory: "accessories",
        rng,
        usageCount,
        usedAccessoryTypes,
        excludeIds,
      });

      if (pickAcc.garment) {
        const accType = pickAcc.accessory_type ?? inferAccessoryType(pickAcc.garment);
        if (accType) usedAccessoryTypes.add(accType);

        markUsed(pickAcc.garment.id);
        chosen.push({
          garment_id: pickAcc.garment.id,
          category: "accessories",
          name: pickAcc.garment.catalog_name ?? "Accessory",
          image_url: pickAcc.garment.image_url,
          tags: getTags(pickAcc.garment),
          fit: pickAcc.garment.fit,
          use_case: pickAcc.garment.use_case,
          accessory_type: accType ?? null,
          reasoning: pickAcc.reasoning,
        });
        reasoning.push(`Accessory: ${pickAcc.reasoning}`);
      }
    }

    // FRAGRANCE (opcional)
    if (includeFragrance) {
      const pickFrag = pickBest({
        pool: fragrance,
        desiredUseCase,
        desiredCategory: "fragrance",
        rng,
        usageCount,
        usedAccessoryTypes,
        excludeIds,
      });

      if (pickFrag.garment) {
        markUsed(pickFrag.garment.id);
        chosen.push({
          garment_id: pickFrag.garment.id,
          category: "fragrance",
          name: pickFrag.garment.catalog_name ?? "Fragrance",
          image_url: pickFrag.garment.image_url,
          tags: getTags(pickFrag.garment),
          fit: pickFrag.garment.fit,
          use_case: pickFrag.garment.use_case,
          reasoning: pickFrag.reasoning,
        });
        reasoning.push(`Fragrance: ${pickFrag.reasoning}`);
      }
    }

    const response = {
      ok: true,
      seed,
      input: {
        user_id: userId,
        use_case: desiredUseCase,
        include_outerwear: includeOuterwear,
        include_accessory: includeAccessory,
        include_fragrance: includeFragrance,
      },
      outfit: {
        items: chosen,
        reasoning: {
          summary:
            "Rules-based outfit generated with diversity controls (accessory optional, anti-repeat, headwear de-weighted in winter).",
          steps: reasoning,
        },
      },
    };

    return NextResponse.json(response, { status: 200 });
  } catch (err: any) {
    console.error("Error in /api/outfits/generate:", err);
    return NextResponse.json({ error: "Server error", details: err?.message ?? "unknown" }, { status: 500 });
  }
}