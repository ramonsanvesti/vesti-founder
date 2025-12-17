// app/api/ingest/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";
import { analyzeGarmentFromImageUrl } from "@/lib/vision";
import { normalizeCategory } from "@/lib/category";
import { inferFit, inferUseCaseTags, pickPrimaryUseCase } from "@/lib/style";
import { searchBestImageFromCSE } from "@/lib/cse";

type IngestMode = "photo" | "text";

type IngestRequestBody =
  | { mode: "photo"; payload: { imageUrl: string } }
  | { mode: "text"; payload: { query: string; imageUrl?: string | null } };

function norm(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function uniq(arr: string[]) {
  return Array.from(new Set(arr.map((x) => x.trim()).filter(Boolean)));
}

/**
 * Very simple query -> tags fallback.
 * - Keeps it visually grounded (colors + nouns/adjectives-ish tokens)
 * - Prevents tag explosion
 */
function tagsFromTextQuery(query: string): string[] {
  const q = norm(query);
  if (!q) return [];

  const stop = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "with",
    "for",
    "of",
    "to",
    "in",
    "on",
    "by",
    "from",
    "new",
    "mens",
    "men",
    "womens",
    "women",
    "kids",
    "size",
    "edition",
  ]);

  const tokens = q
    .split(" ")
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean)
    .filter((t) => !stop.has(t))
    .filter((t) => t.length >= 2);

  // Keep common color words if present
  const colors = new Set([
    "black",
    "white",
    "gray",
    "grey",
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

  const out: string[] = [];
  for (const t of tokens) {
    if (colors.has(t)) out.push(t === "grey" ? "gray" : t);
    else out.push(t);
  }

  // Dedupe + cap
  return uniq(out).slice(0, 25);
}

/**
 * Basic name builder when Vision is missing.
 * Uses query words; we do NOT guess brand/model.
 */
function fallbackCatalogNameFromQuery(query: string) {
  const q = query.trim();
  return q.length ? q : "Unknown Item";
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Partial<IngestRequestBody>;

    if (!body?.mode || !body?.payload) {
      return NextResponse.json({ ok: false, error: "Missing mode or payload" }, { status: 400 });
    }

    // 0) Resolve imageUrl depending on mode
    let imageUrl: string | null = null;
    let textQuery: string | null = null;
    let cseMeta: any = null;

    if (body.mode === "photo") {
      const p: any = body.payload;
      imageUrl = String(p?.imageUrl ?? "").trim();
      if (!imageUrl) {
        return NextResponse.json({ ok: false, error: "payload.imageUrl is empty" }, { status: 400 });
      }
    } else if (body.mode === "text") {
      const p: any = body.payload;
      textQuery = String(p?.query ?? "").trim();
      if (!textQuery) {
        return NextResponse.json({ ok: false, error: "payload.query is empty" }, { status: 400 });
      }

      // Optional direct imageUrl (future/manual override)
      const maybeUrl = String(p?.imageUrl ?? "").trim();
      if (maybeUrl) {
        imageUrl = maybeUrl;
        cseMeta = {
          ok: true,
          source: "user_provided",
          query: textQuery,
          chosen: { link: imageUrl },
        };
      } else {
        // Google CSE -> best image
        const cse = await searchBestImageFromCSE(textQuery);
        if (!cse?.best?.link) {
          return NextResponse.json(
            { ok: false, error: "No image found for query", details: textQuery },
            { status: 404 }
          );
        }

        imageUrl = String(cse.best.link).trim();
        cseMeta = {
          ok: true,
          source: "google_cse",
          query: textQuery,
          chosen: cse.best,
          candidates: Array.isArray(cse.candidates) ? cse.candidates.slice(0, 8) : [],
        };
      }
    } else {
      return NextResponse.json({ ok: false, error: "Invalid mode" }, { status: 400 });
    }

    // 1) Vision AI (never breaks ingest if it fails)
    let visionResult: Awaited<ReturnType<typeof analyzeGarmentFromImageUrl>> = null;
    let visionError: string | null = null;

    try {
      visionResult = await analyzeGarmentFromImageUrl(imageUrl!);
    } catch (e: any) {
      visionError = e?.message ?? "unknown";
      console.warn("Vision failed, continuing without classification:", visionError);
      visionResult = null;
    }

    // 2) Tags: prefer Vision tags; if Vision failed and we have textQuery, fallback to query-based tags
    const visionTags =
      Array.isArray(visionResult?.tags) && visionResult?.tags?.length
        ? visionResult!.tags.map((t) => norm(String(t))).filter(Boolean)
        : [];

    const fallbackQueryTags = textQuery ? tagsFromTextQuery(textQuery) : [];

    const finalTags = uniq([...(visionTags.length ? visionTags : []), ...(visionTags.length ? [] : fallbackQueryTags)]).slice(
      0,
      30
    );

    // 3) Normalize category/subcategory (works even if Vision is null because tags/title can help)
    const normalized = normalizeCategory({
      garmentType: visionResult?.garmentType ?? null,
      subcategory: visionResult?.subcategory ?? null,
      tags: finalTags,
      title:
        visionResult?.catalog_name ??
        (textQuery ? fallbackCatalogNameFromQuery(textQuery) : null),
    });

    // 4) Fit + use case
    const titleForFit = visionResult?.catalog_name ?? (textQuery ? fallbackCatalogNameFromQuery(textQuery) : null);

    const fit = inferFit({ tags: finalTags, title: titleForFit });
    const useCaseTags = inferUseCaseTags({
      tags: finalTags,
      category: normalized.category,
      subcategory: normalized.subcategory,
      title: titleForFit,
    });
    const useCase = pickPrimaryUseCase(useCaseTags);

    // 5) Final catalog name
    // If Vision succeeded, Vision already builds "Brand + Color + Model".
    // If Vision failed, use the text query as the catalog name (no guessing).
    const finalCatalogName =
      (visionResult?.catalog_name ?? "").trim() ||
      (textQuery ? fallbackCatalogNameFromQuery(textQuery) : "") ||
      "unknown";

    // Founder Edition fake user_id (replace with auth later)
    const fakeUserId = "00000000-0000-0000-0000-000000000001";

    // 6) metadata.vision + metadata.cse
    const visionMetadata = visionResult
      ? {
          ok: true,
          provider: visionResult.provider ?? "openai",
          model: visionResult.model ?? null,
          confidence: visionResult.confidence ?? null,
          garmentType: visionResult.garmentType ?? null,
          subcategory: visionResult.subcategory ?? null,
          color: visionResult.color ?? null,
          material: visionResult.material ?? null,
          pattern: (visionResult as any).pattern ?? null,
          seasons: (visionResult as any).seasons ?? [],
          size: visionResult.size ?? null,
          catalog_name: finalCatalogName,
          tags: finalTags,
          normalized: { category: normalized.category, subcategory: normalized.subcategory },
          style: { fit, use_case: useCase, use_case_tags: useCaseTags },
          raw: visionResult.raw ?? null,
        }
      : {
          ok: false,
          reason: "Vision unavailable (missing OPENAI_API_KEY) or Vision error. Inserted with fallback tags.",
          normalized: { category: normalized.category, subcategory: normalized.subcategory },
          style: { fit, use_case: useCase, use_case_tags: useCaseTags },
          vision_error: visionError,
        };

    // 7) Insert garment row
    const supabase = getSupabaseServerClient();

    // IMPORTANT: if your DB has NOT NULL on source, always set it.
    const source = body.mode === "photo" ? "photo" : "text";

    const garmentToInsert: Record<string, any> = {
      user_id: fakeUserId,
      source,
      image_url: imageUrl,

      category: normalized.category,
      subcategory: normalized.subcategory,

      catalog_name: finalCatalogName,
      tags: finalTags,

      fit,
      use_case: useCase,
      use_case_tags: useCaseTags,

      // Optional fields
      color: visionResult?.color ?? null,
      material: visionResult?.material ?? null,
      pattern: (visionResult as any)?.pattern ?? null,
      seasons: (visionResult as any)?.seasons ?? null,
      size: visionResult?.size ?? null,
      raw_text: visionResult?.raw_text ?? null,
      quantity: 1,

      metadata: {
        ...(visionResult?.metadata ?? {}),
        vision: visionMetadata,
        ...(cseMeta ? { cse: cseMeta } : {}),
        ...(textQuery ? { text_query: textQuery } : {}),
      },
    };

    const { data, error } = await supabase
      .from("garments")
      .insert(garmentToInsert)
      .select("*")
      .single();

    if (error) {
      return NextResponse.json({ ok: false, error: "Failed to insert garment", details: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, garment: data }, { status: 200 });
  } catch (err: any) {
    console.error("Error in /api/ingest:", err);
    return NextResponse.json({ ok: false, error: "Server error", details: err?.message ?? "unknown" }, { status: 500 });
  }
}