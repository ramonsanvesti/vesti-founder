// app/api/ingest/route.ts
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

import { getSupabaseServerClient } from "@/lib/supabaseClient.server";
import { normalizeCategory } from "@/lib/category";
import {
  inferFit,
  inferUseCaseTags,
  pickPrimaryUseCase,
  type UseCaseTag,
} from "@/lib/style";
import { searchBestImageFromCSE } from "@/lib/cse";
import {
  analyzeGarmentFromImageUrl,
  analyzeItemsFromImageUrl,
  analyzeOutfitFromImageUrl,
  type VisionResult,
} from "@/lib/vision";

type IngestMode = "photo" | "text" | "batch_photo" | "multi_photo" | "outfit_photo";

type IngestRequestBody =
  | { mode: "photo"; payload: { imageUrl: string } }
  | { mode: "text"; payload: { query: string; imageUrl?: string | null } }
  | { mode: "batch_photo"; payload: { imageUrls: string[] } }
  | { mode: "multi_photo"; payload: { imageUrl: string } }
  | { mode: "outfit_photo"; payload: { imageUrl: string } };

function normTag(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function uniq(arr: string[]) {
  return Array.from(new Set(arr.map(normTag).filter(Boolean)));
}

function titleCase(s: string) {
  return s
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

function clampTags(tags: string[], min = 12, max = 25) {
  const t = uniq(tags);
  if (t.length >= min) return t.slice(0, max);

  // Fillers are conservative and non-speculative.
  const fillers = ["casual", "basic", "solid", "comfortable", "everyday"];
  const out = [...t];
  for (const f of fillers) {
    if (out.length >= min) break;
    if (!out.includes(f)) out.push(f);
  }
  return out.slice(0, max);
}

const SAFE_COLORS = new Set([
  "black",
  "white",
  "gray",
  "navy",
  "brown",
  "beige",
  "green",
  "red",
  "yellow",
  "purple",
  "pink",
  "orange",
  "blue",
]);

const SAFE_MATERIALS = new Set([
  "denim",
  "leather",
  "suede",
  "knit",
  "mesh",
  "canvas",
  "cotton",
  "wool",
  "nylon",
  "polyester",
]);

const SAFE_WORDS = new Set([
  "hoodie",
  "zip",
  "zipper",
  "crewneck",
  "sweater",
  "t shirt",
  "tee",
  "shirt",
  "long sleeve",
  "jacket",
  "coat",
  "puffer",
  "pants",
  "trousers",
  "jeans",
  "joggers",
  "sweatpants",
  "shorts",
  "sneakers",
  "shoes",
  "boots",
  "sandals",
  "slides",
  "beanie",
  "hat",
  "cap",
  "belt",
  "bag",
  "backpack",
  "fragrance",
  "cologne",
  "perfume",
  "logo",
  "graphic",
  "camo",
  "solid",
  "running",
  "training",
  "traction",
  "lace up",
]);

function extractQueryTags(query: string): string[] {
  const q = normTag(query);
  if (!q) return [];
  const tokens = q.split(" ").filter(Boolean);

  const out: string[] = [];

  for (const t of tokens) {
    if (SAFE_COLORS.has(t)) out.push(t);
    if (SAFE_MATERIALS.has(t)) out.push(t);
    if (SAFE_WORDS.has(t)) out.push(t);
  }

  for (let i = 0; i < tokens.length - 1; i++) {
    const bi = `${tokens[i]} ${tokens[i + 1]}`;
    if (SAFE_WORDS.has(bi)) out.push(bi);
  }

  return uniq(out).slice(0, 20);
}

function buildFinalCatalogName(v: VisionResult | null, fallbackText?: string | null) {
  // Brand + Color + Model (Model can be subcategory/garmentType when model_name is null)
  const brand = (v?.brand ?? "").trim();
  const color = (v?.color ?? "").trim();
  const model =
    (v?.model_name ?? "").trim() ||
    (v?.subcategory ?? "").trim() ||
    (v?.garmentType ?? "").trim() ||
    (fallbackText ?? "").trim() ||
    "Item";

  return titleCase([brand, color, model].filter(Boolean).join(" ").trim() || "Unknown Item");
}

function hashFingerprint(input: string) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function buildFingerprint(args: {
  category: string;
  subcategory: string | null;
  color: string | null;
  pattern: string | null;
  tags: string[];
}) {
  const base = [
    args.category,
    args.subcategory ?? "",
    args.color ?? "",
    args.pattern ?? "",
    args.tags.slice(0, 8).join("|"),
  ]
    .map((s) => s.toLowerCase().trim())
    .join("::");

  return hashFingerprint(base);
}

function enforceSlotCategoryLock(args: {
  slotHint: string | null | undefined;
  normalizedCategory: string;
}): { ok: true } | { ok: false; error: string } {
  const { slotHint, normalizedCategory } = args;
  if (!slotHint) return { ok: true };

  // Slot -> allowed category
  const want: Record<string, string> = {
    top: "tops",
    bottom: "bottoms",
    shoes: "shoes",
    outerwear: "outerwear",
    accessory: "accessories",
    fragrance: "fragrance",
  };

  const expected = want[slotHint];
  if (!expected) return { ok: true };

  if (normalizedCategory !== expected) {
    return { ok: false, error: `slot_category_mismatch:${slotHint}:${normalizedCategory}` };
  }

  return { ok: true };
}

async function insertOneGarment(args: {
  supabase: ReturnType<typeof getSupabaseServerClient>;
  userId: string;
  source: string;
  imageUrl: string;
  vision: VisionResult | null;
  sourceImageId: string;
  textQuery?: string | null;
  cseMeta?: any | null;
  slotHint?: string | null;
}) {
  const {
    supabase,
    userId,
    source,
    imageUrl,
    vision,
    sourceImageId,
    textQuery,
    cseMeta,
    slotHint,
  } = args;

  const confidence = typeof vision?.confidence === "number" ? vision.confidence : 0;

  const visionTags = Array.isArray(vision?.tags) ? vision!.tags.map(normTag).filter(Boolean) : [];
  const queryTags = textQuery ? extractQueryTags(textQuery) : [];

  // Confidence gating for stable tags
  let tagsSource: "vision" | "mixed" | "text_fallback" = "vision";
  let combinedTags: string[] = [];

  if (confidence >= 0.85) {
    tagsSource = "vision";
    combinedTags = visionTags;
  } else if (confidence >= 0.6) {
    tagsSource = queryTags.length ? "mixed" : "vision";
    combinedTags = queryTags.length ? [...visionTags, ...queryTags] : visionTags;
  } else {
    tagsSource = queryTags.length ? "text_fallback" : "vision";
    combinedTags = queryTags.length ? [...queryTags, ...visionTags] : visionTags;
  }

  // Slot hint can help stabilization in outfit mode (non-speculative)
  if (slotHint) combinedTags.push(slotHint);

  const finalTags = clampTags(combinedTags, 12, 25);

  const normalized = normalizeCategory({
    garmentType: vision?.garmentType ?? null,
    subcategory: vision?.subcategory ?? null,
    tags: finalTags,
    title: vision?.catalog_name ?? textQuery ?? null,
  });

  // Slot-to-category locking (outfit mode stability)
  const lock = enforceSlotCategoryLock({
    slotHint: slotHint ?? null,
    normalizedCategory: normalized.category,
  });
  if (!lock.ok) {
    return { ok: false, error: lock.error, garment: null };
  }

  const fit = inferFit({ tags: finalTags, title: vision?.catalog_name ?? textQuery ?? null });

  const useCaseTags = inferUseCaseTags({
    tags: finalTags,
    category: normalized.category,
    subcategory: normalized.subcategory,
    title: vision?.catalog_name ?? textQuery ?? null,
  }) as UseCaseTag[];

  const useCase = pickPrimaryUseCase(useCaseTags);

  const finalCatalogName = buildFinalCatalogName(vision, textQuery);

  // Dedupe + grouping
  const fingerprint = buildFingerprint({
    category: normalized.category,
    subcategory: normalized.subcategory,
    color: vision?.color ?? null,
    pattern: vision?.pattern ?? null,
    tags: finalTags,
  });

  // Dedupe within the same source image: avoid inserting near-identical items
  const { data: existing, error: existingErr } = await supabase
    .from("garments")
    .select("*")
    .eq("user_id", userId)
    .eq("source_image_id", sourceImageId)
    .eq("fingerprint", fingerprint)
    .limit(1);

  if (!existingErr && existing && existing.length > 0) {
    return { ok: true, error: null, garment: existing[0], skipped: true };
  }

  const visionMetadata = vision
    ? {
        ok: true,
        provider: vision.provider ?? "openai",
        model: vision.model ?? null,
        confidence: vision.confidence ?? null,
        garmentType: vision.garmentType ?? null,
        subcategory: vision.subcategory ?? null,
        brand: vision.brand ?? null,
        color: vision.color ?? null,
        material: vision.material ?? null,
        pattern: vision.pattern ?? null,
        seasons: vision.seasons ?? [],
        size: vision.size ?? null,
        raw_notes: vision.raw_text ?? null,
        extras: vision.extras ?? null,
        raw: vision.raw ?? null,
      }
    : {
        ok: false,
        reason: "Vision unavailable or failed. Inserted with fallback tags.",
      };

  const garmentToInsert: Record<string, any> = {
    user_id: userId,
    source,
    image_url: imageUrl,

    // NEW: grouping + dedupe
    source_image_id: sourceImageId,
    fingerprint,

    category: normalized.category,
    subcategory: normalized.subcategory,

    catalog_name: finalCatalogName,
    tags: finalTags,

    fit,
    use_case: useCase,
    use_case_tags: useCaseTags,

    brand: vision?.brand ?? null,
    color: vision?.color ?? null,
    material: vision?.material ?? null,
    pattern: vision?.pattern ?? null,
    seasons: vision?.seasons ?? [],
    size: vision?.size ?? null,
    confidence: vision?.confidence ?? null,

    raw_text: vision?.raw_text ?? null,
    quantity: 1,

    metadata: {
      tags_source: tagsSource,
      query_tags: queryTags,
      ...(slotHint ? { slot_hint: slotHint } : {}),
      ...(textQuery ? { text_query: textQuery } : {}),
      ...(cseMeta ? { cse: cseMeta } : {}),
      vision: visionMetadata,
    },
  };

  const { data, error } = await supabase
    .from("garments")
    .insert(garmentToInsert)
    .select("*")
    .single();

  if (error) {
    return { ok: false, error: error.message, garment: null };
  }

  return { ok: true, error: null, garment: data };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as IngestRequestBody | null;

    if (!body?.mode || !body?.payload) {
      return NextResponse.json({ ok: false, error: "Missing mode or payload" }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();

    // Founder Edition fake user_id (replace with auth later)
    const fakeUserId = "00000000-0000-0000-0000-000000000001";

    // PHOTO (single)
    if (body.mode === "photo") {
      const imageUrl = String(body.payload.imageUrl ?? "").trim();
      if (!imageUrl) return NextResponse.json({ ok: false, error: "payload.imageUrl is empty" }, { status: 400 });

      const sourceImageId = crypto.randomUUID();

      let vision: VisionResult | null = null;
      try {
        vision = await analyzeGarmentFromImageUrl(imageUrl);
      } catch {
        vision = null;
      }

      const inserted = await insertOneGarment({
        supabase,
        userId: fakeUserId,
        source: "photo",
        imageUrl,
        vision,
        sourceImageId,
      });

      if (!inserted.ok) {
        return NextResponse.json(
          { ok: false, error: "Failed to insert garment", details: inserted.error },
          { status: 500 }
        );
      }

      return NextResponse.json({ ok: true, garment: inserted.garment, skipped: inserted.skipped ?? false }, { status: 200 });
    }

    // TEXT (CSE -> image -> Vision)
    if (body.mode === "text") {
      const textQuery = String(body.payload.query ?? "").trim();
      if (!textQuery) return NextResponse.json({ ok: false, error: "payload.query is empty" }, { status: 400 });

      const sourceImageId = crypto.randomUUID();

      let imageUrl: string | null = null;
      let cseMeta: any = null;

      const maybeUrl = String(body.payload.imageUrl ?? "").trim();
      if (maybeUrl) {
        imageUrl = maybeUrl;
        cseMeta = { ok: true, source: "user_provided", query: textQuery, chosen: { link: imageUrl } };
      } else {
        const cse = await searchBestImageFromCSE(textQuery);
        if (!cse.best?.link) {
          return NextResponse.json(
            { ok: false, error: "No image found for query", details: textQuery },
            { status: 404 }
          );
        }
        imageUrl = cse.best.link;
        cseMeta = {
          ok: true,
          source: "google_cse",
          query: textQuery,
          chosen: cse.best,
          candidates: (cse.candidates ?? []).slice(0, 8),
        };
      }

      let vision: VisionResult | null = null;
      try {
        vision = await analyzeGarmentFromImageUrl(imageUrl!);
      } catch {
        vision = null;
      }

      const inserted = await insertOneGarment({
        supabase,
        userId: fakeUserId,
        source: "text",
        imageUrl: imageUrl!,
        vision,
        sourceImageId,
        textQuery,
        cseMeta,
      });

      if (!inserted.ok) {
        return NextResponse.json(
          { ok: false, error: "Failed to insert garment", details: inserted.error },
          { status: 500 }
        );
      }

      return NextResponse.json({ ok: true, garment: inserted.garment, skipped: inserted.skipped ?? false }, { status: 200 });
    }

    // BATCH PHOTO (up to 5 images, each = single garment)
    if (body.mode === "batch_photo") {
      const imageUrls = Array.isArray(body.payload.imageUrls) ? body.payload.imageUrls : [];
      const clean = imageUrls
        .map((u) => String(u || "").trim())
        .filter(Boolean)
        .slice(0, 5);

      if (!clean.length) {
        return NextResponse.json({ ok: false, error: "payload.imageUrls must contain 1–5 urls" }, { status: 400 });
      }

      const results: any[] = [];

      for (const imageUrl of clean) {
        const sourceImageId = crypto.randomUUID();

        let vision: VisionResult | null = null;
        try {
          vision = await analyzeGarmentFromImageUrl(imageUrl);
        } catch {
          vision = null;
        }

        const inserted = await insertOneGarment({
          supabase,
          userId: fakeUserId,
          source: "batch_photo",
          imageUrl,
          vision,
          sourceImageId,
        });

        results.push({ imageUrl, ...inserted });
      }

      const okCount = results.filter((r) => r.ok).length;
      return NextResponse.json({ ok: true, inserted: results, okCount }, { status: 200 });
    }

    // MULTI PHOTO (1 image => up to 5 garments)
    if (body.mode === "multi_photo") {
      const imageUrl = String(body.payload.imageUrl ?? "").trim();
      if (!imageUrl) return NextResponse.json({ ok: false, error: "payload.imageUrl is empty" }, { status: 400 });

      const sourceImageId = crypto.randomUUID();

      const items = await analyzeItemsFromImageUrl(imageUrl);

      // If Vision gives nothing, still insert one fallback garment so the user doesn't lose the photo.
      if (!items.length) {
        const inserted = await insertOneGarment({
          supabase,
          userId: fakeUserId,
          source: "multi_photo",
          imageUrl,
          vision: null,
          sourceImageId,
        });

        if (!inserted.ok) {
          return NextResponse.json(
            { ok: false, error: "Failed to insert garment", details: inserted.error },
            { status: 500 }
          );
        }

        return NextResponse.json({ ok: true, garments: [inserted.garment], count: 1, fallback: true }, { status: 200 });
      }

      const insertedGarments: any[] = [];
      const failures: any[] = [];

      for (const vision of items.slice(0, 5)) {
        const inserted = await insertOneGarment({
          supabase,
          userId: fakeUserId,
          source: "multi_photo",
          imageUrl,
          vision,
          sourceImageId,
        });

        if (inserted.ok && inserted.garment) insertedGarments.push(inserted.garment);
        else failures.push({ error: inserted.error });
      }

      return NextResponse.json(
        { ok: true, garments: insertedGarments, count: insertedGarments.length, failures },
        { status: 200 }
      );
    }

    // OUTFIT PHOTO (slot-based extraction => multiple garments)
    if (body.mode === "outfit_photo") {
      const imageUrl = String(body.payload.imageUrl ?? "").trim();
      if (!imageUrl) return NextResponse.json({ ok: false, error: "payload.imageUrl is empty" }, { status: 400 });

      const sourceImageId = crypto.randomUUID();

      const outfit = await analyzeOutfitFromImageUrl(imageUrl);

      if (!outfit) {
        // Save as a single fallback item so the user doesn't lose it.
        const inserted = await insertOneGarment({
          supabase,
          userId: fakeUserId,
          source: "outfit_photo",
          imageUrl,
          vision: null,
          sourceImageId,
        });

        if (!inserted.ok) {
          return NextResponse.json(
            { ok: false, error: "Failed to insert garment", details: inserted.error },
            { status: 500 }
          );
        }

        return NextResponse.json({ ok: true, garments: [inserted.garment], count: 1, fallback: true }, { status: 200 });
      }

      const slotHints: Record<string, string> = {
        top: "top",
        bottom: "bottom",
        shoes: "shoes",
        outerwear: "outerwear",
        accessory: "accessory",
        fragrance: "fragrance",
      };

      const insertedGarments: any[] = [];
      const failures: any[] = [];

      for (const [slot, v] of Object.entries(outfit.slots)) {
        if (!v) continue;

        const inserted = await insertOneGarment({
          supabase,
          userId: fakeUserId,
          source: "outfit_photo",
          imageUrl,
          vision: v,
          sourceImageId,
          slotHint: slotHints[slot] ?? null,
        });

        if (inserted.ok && inserted.garment) insertedGarments.push(inserted.garment);
        else failures.push({ slot, error: inserted.error });
      }

      // If nothing extracted, fallback
      if (!insertedGarments.length) {
        const inserted = await insertOneGarment({
          supabase,
          userId: fakeUserId,
          source: "outfit_photo",
          imageUrl,
          vision: null,
          sourceImageId,
        });

        if (inserted.ok && inserted.garment) insertedGarments.push(inserted.garment);
        else failures.push({ slot: "fallback", error: inserted.error });
      }

      return NextResponse.json(
        {
          ok: true,
          garments: insertedGarments,
          count: insertedGarments.length,
          failures,
          outfit_confidence: outfit.confidence,
          outfit_notes: outfit.raw_notes,
          source_image_id: sourceImageId,
        },
        { status: 200 }
      );
    }

    return NextResponse.json({ ok: false, error: "Invalid mode" }, { status: 400 });
  } catch (err: any) {
    console.error("Error in /api/ingest:", err);
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}