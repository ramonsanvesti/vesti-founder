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

type Slot = "top" | "bottom" | "shoe" | "outerwear" | "accessory";

type GenerateRequest = {
  use_case?: UseCase; // objetivo
  exclude_ids?: string[]; // exclusión manual
  seed_outfit_id?: string | null; // para "regenerate variation": excluye prendas de ese outfit
  include_outerwear?: boolean; // opcional (default: false)
};

type GarmentRow = {
  id: string;
  user_id: string;
  category: string | null;
  subcategory: string | null;
  catalog_name: string | null;
  image_url: string | null;

  brand: string | null;
  color: string | null;
  material: string | null;
  size: string | null;

  tags: string[] | null; // text[]
  fit: string | null; // text
  use_case: string | null; // text
  use_case_tags: string[] | null; // text[]

  metadata: any; // jsonb
  created_at?: string;
};

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function norm(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function asArr(v: any): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  return [];
}

function safeStr(v: any): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function containsAny(blob: string, needles: string[]) {
  return needles.some((n) => blob.includes(n));
}

function pickPrimaryColor(color: string | null, tags: string[]) {
  const blob = norm(`${color ?? ""} ${tags.join(" ")}`);
  if (containsAny(blob, ["black"])) return "black";
  if (containsAny(blob, ["white", "off white", "cream"])) return "white";
  if (containsAny(blob, ["grey", "gray", "charcoal"])) return "grey";
  if (containsAny(blob, ["navy"])) return "navy";
  if (containsAny(blob, ["brown", "tan", "khaki", "beige"])) return "brown";
  if (containsAny(blob, ["green", "olive"])) return "green";
  if (containsAny(blob, ["red", "burgundy", "maroon"])) return "red";
  if (containsAny(blob, ["blue"])) return "blue";
  return "neutral";
}

function colorCompatScore(a: string, b: string) {
  // súper simple para v1:
  // neutrals combinan con todo; mismo color suma; colores cercanos leve.
  if (a === "neutral" || b === "neutral") return 1.0;
  if (a === b) return 1.2;

  const neutralish = new Set(["black", "white", "grey", "navy", "brown"]);
  if (neutralish.has(a) && neutralish.has(b)) return 1.05;

  // combos comunes
  const goodPairs = new Set([
    "black+red",
    "red+black",
    "black+green",
    "green+black",
    "navy+white",
    "white+navy",
    "brown+white",
    "white+brown",
    "grey+black",
    "black+grey",
  ]);
  if (goodPairs.has(`${a}+${b}`)) return 1.05;

  return 0.9;
}

function useCaseMatchScore(item: GarmentRow, target: UseCase) {
  // fallback inteligente:
  // 1) match exacto
  // 2) match en use_case_tags
  // 3) casual es comodín
  // 4) null no bloquea
  const uc = norm(item.use_case ?? "");
  const tags = asArr(item.use_case_tags).map(norm);

  if (uc === norm(target)) return 3.0;
  if (tags.includes(norm(target))) return 2.2;
  if (uc === "casual") return 1.4;
  if (!uc) return 1.1;

  // si no matchea, no lo mates: solo baja score
  return 0.6;
}

function fitAffinityScore(item: GarmentRow, targetFit: string | null) {
  const f = norm(item.fit ?? "");
  if (!targetFit) return 1.0;
  if (!f) return 0.95;
  if (f === norm(targetFit)) return 1.15;

  // streetwear tolera relaxed/oversized
  const loose = new Set(["relaxed", "oversized"]);
  if (loose.has(f) && loose.has(norm(targetFit))) return 1.08;

  return 0.95;
}

function baseItemScore(item: GarmentRow, targetUseCase: UseCase, targetFit: string | null) {
  const tags = asArr(item.tags).map(norm);
  const title = norm(item.catalog_name ?? "");
  const blob = `${title} ${tags.join(" ")}`;

  let score = 10; // base
  score *= useCaseMatchScore(item, targetUseCase);
  score *= fitAffinityScore(item, targetFit);

  // bonus: “clean” basics para work/casual
  if (targetUseCase === "work" || targetUseCase === "casual") {
    if (containsAny(blob, ["basic", "solid", "minimal"])) score *= 1.05;
  }

  // bonus: streetwear
  if (targetUseCase === "streetwear") {
    if (containsAny(blob, ["logo", "graphic", "hoodie", "drawstring", "cargo"])) score *= 1.05;
  }

  // winter
  if (targetUseCase === "winter") {
    if (containsAny(blob, ["fleece", "wool", "puffer", "beanie"])) score *= 1.05;
  }

  return score;
}

function chooseTargetFit(useCase: UseCase) {
  // v1 simple
  if (useCase === "streetwear") return "relaxed";
  if (useCase === "work") return "regular";
  if (useCase === "athletic") return "regular";
  if (useCase === "lounge") return "relaxed";
  return "regular";
}

function isHeadwear(item: GarmentRow) {
  const tags = asArr(item.tags).map(norm);
  const title = norm(item.catalog_name ?? "");
  const blob = `${title} ${tags.join(" ")}`;
  return containsAny(blob, ["beanie", "cap", "hat", "headwear"]);
}

function accessoryAllowed(item: GarmentRow, targetUseCase: UseCase) {
  // Control: no “beanie always-on”
  // Headwear solo si winter (o si el item explícitamente es winter)
  if (isHeadwear(item)) {
    if (targetUseCase === "winter") return true;
    const uctags = asArr(item.use_case_tags).map(norm);
    if (uctags.includes("winter") || norm(item.use_case ?? "") === "winter") return true;
    return false;
  }
  return true;
}

async function loadSeedExclusions(supabase: any, seedOutfitId: string) {
  const { data, error } = await supabase
    .from("outfit_items")
    .select("garment_id")
    .eq("outfit_id", seedOutfitId);

  if (error) return [];
  return uniq((data ?? []).map((r: any) => String(r.garment_id)));
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as GenerateRequest;

    const targetUseCase: UseCase = (body.use_case ?? "casual") as UseCase;
    const includeOuterwear = Boolean(body.include_outerwear);

    // Founder Edition fake user_id
    const fakeUserId = "00000000-0000-0000-0000-000000000001";

    const supabase = getSupabaseServerClient();

    // Exclusions: manual + seed outfit (variations)
    const manualExclude = uniq(asArr(body.exclude_ids));
    const seedExclude = body.seed_outfit_id ? await loadSeedExclusions(supabase, body.seed_outfit_id) : [];
    const excludeSet = new Set<string>([...manualExclude, ...seedExclude]);

    // Pull wardrobe
    const { data: garments, error } = await supabase
      .from("garments")
      .select(
        "id,user_id,category,subcategory,catalog_name,image_url,brand,color,material,size,tags,fit,use_case,use_case_tags,metadata,created_at"
      )
      .eq("user_id", fakeUserId)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: "Failed to load garments", details: error.message }, { status: 500 });
    }

    const rows = (garments ?? []) as GarmentRow[];

    // Candidates by category (exclude ids + must have image)
    const tops = rows.filter((g) => g.category === "tops" && !excludeSet.has(g.id));
    const bottoms = rows.filter((g) => g.category === "bottoms" && !excludeSet.has(g.id));
    const shoes = rows.filter((g) => g.category === "shoes" && !excludeSet.has(g.id));
    const outerwear = rows.filter((g) => g.category === "outerwear" && !excludeSet.has(g.id));
    const accessories = rows.filter((g) => g.category === "accessories" && !excludeSet.has(g.id));

    // Min requirements
    if (tops.length === 0 || bottoms.length === 0 || shoes.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          reason: "No se generó ningún outfit. Falta data (tops/bottoms/shoes) después de aplicar exclusions.",
          counts: { tops: tops.length, bottoms: bottoms.length, shoes: shoes.length },
          debug: { excluded_manual: manualExclude.length, excluded_seed: seedExclude.length },
        },
        { status: 200 }
      );
    }

    const targetFit = chooseTargetFit(targetUseCase);

    // Pick top
    const topScored = tops
      .map((g) => ({ g, s: baseItemScore(g, targetUseCase, targetFit) }))
      .sort((a, b) => b.s - a.s);

    const top = topScored[0].g;
    excludeSet.add(top.id);

    // Pick bottom with color compatibility to top
    const topColor = pickPrimaryColor(top.color, asArr(top.tags));
    const bottomScored = bottoms
      .filter((g) => !excludeSet.has(g.id))
      .map((g) => {
        const c = pickPrimaryColor(g.color, asArr(g.tags));
        const compat = colorCompatScore(topColor, c);
        const s = baseItemScore(g, targetUseCase, targetFit) * compat;
        return { g, s, compat, c };
      })
      .sort((a, b) => b.s - a.s);

    const bottom = bottomScored[0].g;
    excludeSet.add(bottom.id);

    // Pick shoes with compatibility to top+bottom
    const bottomColor = pickPrimaryColor(bottom.color, asArr(bottom.tags));
    const shoeScored = shoes
      .filter((g) => !excludeSet.has(g.id))
      .map((g) => {
        const c = pickPrimaryColor(g.color, asArr(g.tags));
        const compat =
          (colorCompatScore(topColor, c) + colorCompatScore(bottomColor, c)) / 2;
        const s = baseItemScore(g, targetUseCase, targetFit) * compat;
        return { g, s, compat, c };
      })
      .sort((a, b) => b.s - a.s);

    if (shoeScored.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          reason: "No se generó ningún outfit. Tus shoes existen, pero quedaron fuera por exclusions o filtros.",
          counts: { tops: tops.length, bottoms: bottoms.length, shoes: shoes.length },
        },
        { status: 200 }
      );
    }

    const shoe = shoeScored[0].g;
    excludeSet.add(shoe.id);

    // Optional outerwear (only if requested or use case winter)
    let pickedOuterwear: GarmentRow | null = null;
    if (includeOuterwear || targetUseCase === "winter") {
      const owScored = outerwear
        .filter((g) => !excludeSet.has(g.id))
        .map((g) => {
          const c = pickPrimaryColor(g.color, asArr(g.tags));
          const compat =
            (colorCompatScore(topColor, c) + colorCompatScore(bottomColor, c)) / 2;
          const s = baseItemScore(g, targetUseCase, targetFit) * compat;
          return { g, s };
        })
        .sort((a, b) => b.s - a.s);

      if (owScored.length) {
        pickedOuterwear = owScored[0].g;
        excludeSet.add(pickedOuterwear.id);
      }
    }

    // Accessory control: max 1, and block headwear unless allowed
    let pickedAccessory: GarmentRow | null = null;
    const accCandidates = accessories.filter((g) => !excludeSet.has(g.id)).filter((g) => accessoryAllowed(g, targetUseCase));

    // only add accessory if it increases coherence:
    // - winter: likely yes
    // - otherwise: only if not headwear + matches palette
    if (accCandidates.length) {
      const accScored = accCandidates
        .map((g) => {
          const c = pickPrimaryColor(g.color, asArr(g.tags));
          const compat =
            (colorCompatScore(topColor, c) + colorCompatScore(bottomColor, c)) / 2;
          const s = baseItemScore(g, targetUseCase, targetFit) * compat;
          return { g, s };
        })
        .sort((a, b) => b.s - a.s);

      const best = accScored[0]?.g ?? null;

      if (best) {
        const isHW = isHeadwear(best);
        if (targetUseCase === "winter") {
          pickedAccessory = best;
          excludeSet.add(best.id);
        } else if (!isHW) {
          // for non-winter, only non-headwear accessories
          pickedAccessory = best;
          excludeSet.add(best.id);
        }
      }
    }

    // Reasoning (humano)
    const topName = top.catalog_name ?? "Top";
    const bottomName = bottom.catalog_name ?? "Bottom";
    const shoeName = shoe.catalog_name ?? "Shoes";
    const owName = pickedOuterwear?.catalog_name ?? null;
    const accName = pickedAccessory?.catalog_name ?? null;

    const reasoningLines: string[] = [];

    reasoningLines.push(`Objetivo: **${targetUseCase}** con fit preferido **${targetFit}**.`);
    reasoningLines.push(`Elegí **${topName}** como base por compatibilidad de uso y tags.`);
    reasoningLines.push(`Luego **${bottomName}** para balancear el look y mantener una paleta coherente.`);
    reasoningLines.push(`Cerré con **${shoeName}** como ancla: match por use case o fallback (casual/tags) sin bloquear el outfit.`);

    if (pickedOuterwear) reasoningLines.push(`Añadí outerwear: **${owName}** para completar la silueta.`);
    if (pickedAccessory) {
      if (isHeadwear(pickedAccessory)) {
        reasoningLines.push(`Accessory: **${accName}** permitido porque estamos en **winter** (headwear control).`);
      } else {
        reasoningLines.push(`Accessory: **${accName}** porque suma sin ruido y respeta la paleta.`);
      }
    } else {
      reasoningLines.push(`No agregué accessory para evitar repetición o ruido (control de accesorios activo).`);
    }

    const reasoning = reasoningLines.join(" ");

    // Persist to outfits + outfit_items
    const outfitInsert = {
      user_id: fakeUserId,
      use_case: targetUseCase,
      fit: targetFit,
      reasoning,
      metadata: {
        generator: "rules_v1",
        include_outerwear: includeOuterwear,
        exclusions: {
          manual: manualExclude,
          seed_outfit_id: body.seed_outfit_id ?? null,
          seed: seedExclude,
        },
        palette: { top: topColor, bottom: bottomColor },
      },
    };

    const { data: outfit, error: outfitErr } = await supabase
      .from("outfits")
      .insert(outfitInsert)
      .select("*")
      .single();

    if (outfitErr) {
      return NextResponse.json({ error: "Failed to insert outfit", details: outfitErr.message }, { status: 500 });
    }

    const outfitId = outfit.id;

    const items: Array<{ outfit_id: string; garment_id: string; slot: Slot; position: number }> = [
      { outfit_id: outfitId, garment_id: top.id, slot: "top", position: 1 },
      { outfit_id: outfitId, garment_id: bottom.id, slot: "bottom", position: 2 },
      { outfit_id: outfitId, garment_id: shoe.id, slot: "shoe", position: 3 },
    ];

    if (pickedOuterwear) items.push({ outfit_id: outfitId, garment_id: pickedOuterwear.id, slot: "outerwear", position: 4 });
    if (pickedAccessory) items.push({ outfit_id: outfitId, garment_id: pickedAccessory.id, slot: "accessory", position: 5 });

    const { error: itemsErr } = await supabase.from("outfit_items").insert(items);

    if (itemsErr) {
      return NextResponse.json({ error: "Failed to insert outfit_items", details: itemsErr.message }, { status: 500 });
    }

    // Return full payload (ready for UI)
    return NextResponse.json(
      {
        ok: true,
        outfit: {
          ...outfit,
          items: [
            { slot: "top", garment: top },
            { slot: "bottom", garment: bottom },
            { slot: "shoe", garment: shoe },
            ...(pickedOuterwear ? [{ slot: "outerwear", garment: pickedOuterwear }] : []),
            ...(pickedAccessory ? [{ slot: "accessory", garment: pickedAccessory }] : []),
          ],
          reasoning,
          exclude_ids_next: uniq(items.map((x) => x.garment_id)), // útil para "regenerate variation"
        },
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