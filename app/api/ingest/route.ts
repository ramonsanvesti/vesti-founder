import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type IngestMode = "photo";

type IngestRequestBody = {
  mode: IngestMode;
  payload: { imageUrl: string };
};

type Department =
  | "tops"
  | "bottoms"
  | "outerwear"
  | "shoes"
  | "accessories"
  | "fragrance";

type VisionGarment = {
  catalogName: string | null;
  department: Department;
  category: string | null;
  subcategory: string | null;

  brand: string | null;
  color: string | null;
  material: string | null;
  size: string | null;

  tags: string[];
  confidence: number; // 0..1
  notes: string | null;
};

function getSupabaseServerClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("SUPABASE_URL is missing");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing");

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is missing`);
  return v;
}

function isValidHttpUrl(s: string) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function clamp01(n: unknown) {
  if (typeof n !== "number") return 0.3;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter(Boolean)
    .slice(0, 20);
}

async function callVisionAI(imageUrl: string): Promise<{
  garment: VisionGarment;
  rawText: string;
  model: string;
}> {
  const OPENAI_API_KEY = requireEnv("OPENAI_API_KEY");
  const model = "gpt-4.1-mini";

  const schema = {
    name: "vesti_vision_item",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        catalogName: {
          type: ["string", "null"],
          description:
            "Catalog-style name, e.g. 'GAP Full-Zip Hoodie, Heather Gray' or 'Nike Air Max Sneakers, White/Red'. If uncertain, null.",
        },
        department: {
          type: "string",
          enum: [
            "tops",
            "bottoms",
            "outerwear",
            "shoes",
            "accessories",
            "fragrance",
          ],
          description:
            "Pick exactly one. If it's a perfume/cologne bottle, choose 'fragrance'.",
        },
        category: {
          type: ["string", "null"],
          description:
            "Specific item type. Examples: t-shirt, shirt, hoodie, sweater, jeans, trousers, shorts, jacket, coat, sneakers, boots, hat, bag, belt, watch, sunglasses, perfume, cologne.",
        },
        subcategory: { type: ["string", "null"] },

        brand: { type: ["string", "null"] },
        color: {
          type: ["string", "null"],
          description:
            "Simple primary color like black, white, gray, navy, green, red, beige, brown, purple.",
        },
        material: { type: ["string", "null"] },
        size: { type: ["string", "null"] },

        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Short tags useful for wardrobe search. Examples: ['zip-up','logo','casual','oversized','streetwear'] or for fragrance ['woody','spicy','fresh','night','office'].",
        },

        confidence: { type: "number", minimum: 0, maximum: 1 },
        notes: { type: ["string", "null"] },
      },
      required: [
        "catalogName",
        "department",
        "category",
        "subcategory",
        "brand",
        "color",
        "material",
        "size",
        "tags",
        "confidence",
        "notes",
      ],
    },
  } as const;

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content:
            "You are VESTI Vision AI. Return only valid JSON matching the schema. Be conservative: if unsure, set null and lower confidence. Never hallucinate brand.",
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Analyze this photo. Identify the item and output structured attributes. Must support tops, bottoms, outerwear, shoes, accessories, and fragrance.",
            },
            { type: "input_image", image_url: imageUrl },
          ],
        },
      ],
      text: {
        format: { type: "json_schema", json_schema: schema },
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI Vision error: ${res.status} ${errText}`);
  }

  const data = await res.json();

  const rawText =
    (typeof data?.output_text === "string" && data.output_text) ||
    JSON.stringify(data);

  let parsed: any = null;

  // Try parse via output structure first
  try {
    const outText = data?.output?.[0]?.content?.find(
      (c: any) => c?.type === "output_text"
    )?.text;
    if (typeof outText === "string") parsed = JSON.parse(outText);
  } catch {}

  // Fallback: parse output_text
  if (!parsed) {
    try {
      parsed = JSON.parse(data.output_text);
    } catch {
      throw new Error("Vision response could not be parsed as JSON");
    }
  }

  const garment: VisionGarment = {
    catalogName:
      typeof parsed.catalogName === "string" ? parsed.catalogName : null,
    department: ([
      "tops",
      "bottoms",
      "outerwear",
      "shoes",
      "accessories",
      "fragrance",
    ] as const).includes(parsed.department)
      ? parsed.department
      : "accessories",

    category: typeof parsed.category === "string" ? parsed.category : null,
    subcategory:
      typeof parsed.subcategory === "string" ? parsed.subcategory : null,

    brand: typeof parsed.brand === "string" ? parsed.brand : null,
    color: typeof parsed.color === "string" ? parsed.color : null,
    material: typeof parsed.material === "string" ? parsed.material : null,
    size: typeof parsed.size === "string" ? parsed.size : null,

    tags: normalizeTags(parsed.tags),
    confidence: clamp01(parsed.confidence),
    notes: typeof parsed.notes === "string" ? parsed.notes : null,
  };

  return { garment, rawText, model };
}

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseServerClient();
    const body = (await req.json()) as IngestRequestBody;

    if (!body?.mode || !body?.payload?.imageUrl) {
      return NextResponse.json(
        { error: "Missing mode or payload.imageUrl" },
        { status: 400 }
      );
    }

    if (body.mode !== "photo") {
      return NextResponse.json(
        { error: "Invalid mode. Only 'photo' supported for now." },
        { status: 400 }
      );
    }

    const { imageUrl } = body.payload;

    if (!isValidHttpUrl(imageUrl)) {
      return NextResponse.json({ error: "Invalid imageUrl" }, { status: 400 });
    }

    // 1) Vision AI
    const vision = await callVisionAI(imageUrl);

    // 2) Insert (user fijo hasta auth)
    const fakeUserId = "00000000-0000-0000-0000-000000000001";

    // title = catalogName (fallback a category/department)
    const title =
      vision.garment.catalogName ??
      vision.garment.category ??
      vision.garment.department ??
      "Item";

    // category fallback
    const category =
      vision.garment.category ??
      (vision.garment.department === "fragrance" ? "fragrance" : "unknown");

    const garmentToInsert = {
      user_id: fakeUserId,
      source: "photo",
      source_id: null,

      title,
      brand: vision.garment.brand,
      category,
      subcategory: vision.garment.subcategory,
      color: vision.garment.color,
      size: vision.garment.size,
      material: vision.garment.material,

      quantity: 1,
      image_url: imageUrl,

      embedding: null,
      raw_text: vision.rawText,
      metadata: {
        department: vision.garment.department,
        tags: vision.garment.tags,
        vision: {
          model: vision.model,
          confidence: vision.garment.confidence,
          notes: vision.garment.notes,
        },
      },
    };

    const { data, error } = await supabase
      .from("garments")
      .insert(garmentToInsert)
      .select("*")
      .single();

    if (error) {
      return NextResponse.json(
        { error: "Failed to insert garment", details: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json(data, { status: 200 });
  } catch (err: any) {
    console.error("Error in /api/ingest:", err);
    return NextResponse.json(
      { error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}
