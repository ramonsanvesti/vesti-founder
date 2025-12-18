// lib/vision.ts
import "server-only";

export type VisionResult = {
  // UI + DB
  catalog_name: string;

  // For category normalization
  garmentType: string | null;
  subcategory: string | null;

  // Attributes
  brand: string | null;
  color: string | null;
  model_name: string | null;
  material: string | null;
  pattern: string | null;
  seasons: string[]; // ["winter","fall"]
  size: string | null;

  // Tags (final)
  tags: string[];

  // Confidence 0..1 (overall certainty across key fields)
  confidence: number;

  // One short visually-grounded sentence (raw_notes mapped to raw_text for storage/UI)
  raw_text: string | null;

  // Clean metadata for storage + optional structured extras (closure, neckline, etc.)
  metadata: Record<string, any>;
  extras: Record<string, any> | null;

  // Tracing
  provider: "openai";
  model: string | null;

  // Full raw response
  raw: any;
};

type MultiVisionResponse = {
  items: Array<{
    brand: string | null;
    color: string | null;
    model_name: string | null;
    catalog_name: string | null;
    garmentType: string | null;
    subcategory: string | null;
    material: string | null;
    pattern: string | null;
    seasons: string[];
    size: string | null;
    tags: string[];
    confidence: number;
    raw_notes: string;
    extras: Record<string, any>;
  }>;
  confidence: number; // overall
  raw_notes: string;
};

type OutfitVisionResponse = {
  slots: {
    top?: any | null;
    bottom?: any | null;
    shoes?: any | null;
    outerwear?: any | null;
    accessory?: any | null;
    fragrance?: any | null;
    other?: any[] | null; // extra detections
  };
  confidence: number;
  raw_notes: string;
};

function uniq(arr: string[]) {
  return Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
}

function normTag(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function safeString(v: any): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function clamp01(n: any, fallback = 0.5) {
  if (typeof n !== "number" || Number.isNaN(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function titleCase(s: string) {
  return s
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

function asStringArray(v: any): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).map((x) => x.trim()).filter(Boolean);
  return [];
}

function normalizeSeason(s: string) {
  const t = normTag(s);
  if (t.includes("spring")) return "spring";
  if (t.includes("summer")) return "summer";
  if (t.includes("fall") || t.includes("autumn")) return "fall";
  if (t.includes("winter")) return "winter";
  return "";
}

function extractOutputText(resJson: any): string | null {
  if (typeof resJson?.output_text === "string") return resJson.output_text;

  const first = resJson?.output?.[0];
  const c0 = first?.content?.[0];

  if (typeof c0?.text === "string") return c0.text;
  if (typeof c0?.value === "string") return c0.value;

  return null;
}

function clampTags(tags: string[], min = 12, max = 25) {
  const uniqed = uniq(tags.map(normTag));
  if (uniqed.length >= min) return uniqed.slice(0, max);

  // Ultra-generic fillers (non-speculative) only if needed to meet minimum tag count.
  const fillers = ["wearable", "item", "apparel", "wardrobe", "clothing"];
  const out = [...uniqed];
  for (const f of fillers) {
    if (out.length >= min) break;
    if (!out.includes(f)) out.push(f);
  }

  return out.slice(0, max);
}

function buildCatalogName(parsed: any) {
  // Brand + Color + Model
  const brand = safeString(parsed?.brand);
  const color = safeString(parsed?.color);
  const model = safeString(parsed?.model_name) || safeString(parsed?.subcategory) || safeString(parsed?.garmentType);

  const parts = [brand, color, model].filter(Boolean) as string[];
  if (parts.length) return titleCase(parts.join(" "));

  const fallback =
    safeString(parsed?.catalog_name) ||
    safeString(parsed?.title) ||
    "Unknown Item";
  return titleCase(fallback);
}

function tokenize(s: string): string[] {
  return normTag(s)
    .split(" ")
    .map((t) => t.trim())
    .filter(Boolean);
}

function buildDerivedTags(parsed: any): string[] {
  const base = asStringArray(parsed?.tags).map(normTag).filter(Boolean);

  const derived: string[] = [];

  const garmentType = safeString(parsed?.garmentType);
  const subcategory = safeString(parsed?.subcategory);
  const color = safeString(parsed?.color);
  const material = safeString(parsed?.material);
  const pattern = safeString(parsed?.pattern);

  if (garmentType) derived.push(...tokenize(garmentType));
  if (subcategory) derived.push(...tokenize(subcategory));
  if (color) derived.push(normTag(color));
  if (material) derived.push(normTag(material));
  if (pattern) derived.push(normTag(pattern));

  const seasons = uniq(asStringArray(parsed?.seasons).map(normalizeSeason).filter(Boolean));
  for (const s of seasons) derived.push(s);

  // Pull a few safe structured extras if present (visually grounded)
  const extras = parsed?.extras && typeof parsed.extras === "object" ? parsed.extras : null;
  const extraKeys = ["closure", "neckline", "length", "pockets", "logo_placement", "hardware"];
  if (extras) {
    for (const k of extraKeys) {
      const v = (extras as any)[k];
      if (typeof v === "string") derived.push(...tokenize(v));
    }

    const secondary = (extras as any)?.secondary_colors;
    if (Array.isArray(secondary)) {
      for (const c of secondary) {
        if (typeof c === "string") derived.push(normTag(c));
      }
    }
  }

  return uniq([...base, ...derived].map(normTag).filter(Boolean));
}

function finalizeSingle(parsed: any, rawResponse: any): VisionResult {
  const derivedTags = buildDerivedTags(parsed);
  const tags = clampTags(derivedTags, 12, 25);

  const seasons = uniq(asStringArray(parsed?.seasons).map(normalizeSeason).filter(Boolean));
  const rawNotes = safeString(parsed?.raw_notes);

  const extras = parsed?.extras && typeof parsed.extras === "object" ? parsed.extras : null;

  return {
    provider: "openai",
    model: safeString(rawResponse?.model) ?? "unknown",

    catalog_name: buildCatalogName(parsed),

    garmentType: safeString(parsed?.garmentType),
    subcategory: safeString(parsed?.subcategory),

    brand: safeString(parsed?.brand),
    color: safeString(parsed?.color),
    model_name: safeString(parsed?.model_name),
    material: safeString(parsed?.material),
    pattern: safeString(parsed?.pattern),
    seasons,
    size: safeString(parsed?.size),

    tags,

    confidence: clamp01(parsed?.confidence, 0.5),
    raw_text: rawNotes,

    metadata: {
      brand: safeString(parsed?.brand),
      color: safeString(parsed?.color),
      model_name: safeString(parsed?.model_name),
      garmentType: safeString(parsed?.garmentType),
      subcategory: safeString(parsed?.subcategory),
      material: safeString(parsed?.material),
      pattern: safeString(parsed?.pattern),
      seasons,
      size: safeString(parsed?.size),
      tags,
      raw_notes: rawNotes,
      extras,
    },

    extras,

    raw: {
      parsed,
      raw_response: rawResponse,
    },
  };
}

function buildSystemPromptSingle(): string {
  return `
You are VESTI Vision AI.

Analyze ONE product photo (clothing, shoes, accessories, or fragrance). Extract only what is visually evident. If uncertain, output null instead of guessing.

Return ONLY valid JSON. No markdown. No commentary. No trailing commas.

Output schema (use these exact keys)

{
"brand": "string|null",
"color": "string|null",
"model_name": "string|null",
"catalog_name": "string|null",
"garmentType": "string|null",
"subcategory": "string|null",
"material": "string|null",
"pattern": "string|null",
"seasons": ["spring|summer|fall|winter"],
"size": "string|null",
"tags": ["string"],
"confidence": 0.0,
"raw_notes": "string",
"extras": {}
}

Hard rules
- brand: ONLY if clearly readable/identifiable from the image. Otherwise null.
- model_name: ONLY if clearly inferable. Otherwise null.
- catalog_name: optional; if unknown, set null (we rebuild it later).
- garmentType: primary type.
- subcategory: more specific than garmentType.
- color: base color only. Secondary colors go in tags/extras.
- material: only if reasonably inferable.
- pattern: one of: solid, stripes, plaid, camo, logo/graphic, check, floral, abstract, heather, colorblock, text. If unsure: null.
- seasons: 0–4. If unknown: [].
- size: ONLY if visible on tag/label.

Tags
- 12 to 25 tags.
- lowercase, concise, no duplicates.
- visually grounded only. No gender. No “luxury/designer/limited”.
- prefer useful details: silhouette, closures, neckline, sleeve length, sole type, hardware, pockets, logo placement, texture.

Confidence
- float 0.00–1.00.

raw_notes
- One short sentence describing what you saw. No speculation.

extras
- optional structured details when visible:
  closure, neckline, length, pockets, logo_placement, secondary_colors[], hardware.

Multi-item rule
- If multiple products appear, analyze the primary item in focus and ignore the rest.
`.trim();
}

function buildSystemPromptMulti(): string {
  return `
You are VESTI Vision AI.

Analyze ONE photo that may contain multiple apparel items (up to 5 distinct wearable products).
Extract only what is visually evident. If uncertain, output null.

Return ONLY valid JSON. No markdown. No commentary. No trailing commas.

Output schema (use these exact keys)

{
"items": [
  {
    "brand": "string|null",
    "color": "string|null",
    "model_name": "string|null",
    "catalog_name": "string|null",
    "garmentType": "string|null",
    "subcategory": "string|null",
    "material": "string|null",
    "pattern": "string|null",
    "seasons": ["spring|summer|fall|winter"],
    "size": "string|null",
    "tags": ["string"],
    "confidence": 0.0,
    "raw_notes": "string",
    "extras": {}
  }
],
"confidence": 0.0,
"raw_notes": "string"
}

Rules
- items: 1 to 5 items max. Do NOT exceed 5.
- If the photo is a full outfit, include top/bottom/shoes/outerwear/accessory if visible.
- Same hard rules for brand/model_name/size/tags as single-item mode.
- tags must be 12–25 per item.
- confidence: overall confidence for the whole response. Each item also has its own confidence.
- raw_notes: one short sentence about what you saw overall.
`.trim();
}

function buildSystemPromptOutfit(): string {
  return `
You are VESTI Vision AI.

Analyze ONE outfit photo and extract as many distinct wearable elements as possible into slots.

Return ONLY valid JSON. No markdown. No commentary. No trailing commas.

Output schema:

{
"slots": {
  "top": { ...item|null },
  "bottom": { ...item|null },
  "shoes": { ...item|null },
  "outerwear": { ...item|null },
  "accessory": { ...item|null },
  "fragrance": { ...item|null },
  "other": [ ...item ]|null
},
"confidence": 0.0,
"raw_notes": "string"
}

Where item follows:

{
"brand": "string|null",
"color": "string|null",
"model_name": "string|null",
"catalog_name": "string|null",
"garmentType": "string|null",
"subcategory": "string|null",
"material": "string|null",
"pattern": "string|null",
"seasons": ["spring|summer|fall|winter"],
"size": "string|null",
"tags": ["string"],
"confidence": 0.0,
"raw_notes": "string",
"extras": {}
}

Rules
- Populate slots only if the element is clearly visible. Otherwise null.
- Do not invent accessories/fragrance.
- If multiple accessories exist, put the primary one in "accessory" and the rest in "other".
- tags 12–25 per item, visually grounded.
- confidence is overall.
`.trim();
}

async function callOpenAIJson(system: string, imageUrl: string): Promise<{ parsed: any; raw: any } | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const body = {
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Analyze this image and return JSON that matches the schema exactly." },
          { type: "input_image", image_url: imageUrl },
        ],
      },
    ],
    text: { format: { type: "json_object" } },
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.warn("Vision request failed:", res.status, txt);
    return null;
  }

  const json = await res.json();
  const outputText = extractOutputText(json);

  let parsed: any = null;

  if (outputText) {
    try {
      parsed = JSON.parse(outputText);
    } catch {
      console.warn("Vision output was not valid JSON:", outputText);
      return null;
    }
  } else {
    const maybeObj = json?.output?.[0]?.content?.[0]?.json;
    if (maybeObj && typeof maybeObj === "object") parsed = maybeObj;
  }

  if (!parsed) return null;
  return { parsed, raw: json };
}

/**
 * Single-item analysis (existing behavior).
 * Returns null if Vision is unavailable or fails.
 */
export async function analyzeGarmentFromImageUrl(imageUrl: string): Promise<VisionResult | null> {
  try {
    const system = buildSystemPromptSingle();
    const out = await callOpenAIJson(system, imageUrl);
    if (!out) return null;
    return finalizeSingle(out.parsed, out.raw);
  } catch (err: any) {
    console.warn("Vision single failed:", err?.message ?? err);
    return null;
  }
}

/**
 * Multi-item analysis: up to 5 items from one image.
 * Returns [] if Vision unavailable or fails.
 */
export async function analyzeItemsFromImageUrl(imageUrl: string): Promise<VisionResult[]> {
  try {
    const system = buildSystemPromptMulti();
    const out = await callOpenAIJson(system, imageUrl);
    if (!out) return [];

    const parsed = out.parsed as MultiVisionResponse;
    const items = Array.isArray(parsed?.items) ? parsed.items.slice(0, 5) : [];

    const results: VisionResult[] = [];
    for (const it of items) {
      results.push(finalizeSingle(it, out.raw));
    }

    return results;
  } catch (err: any) {
    console.warn("Vision multi failed:", err?.message ?? err);
    return [];
  }
}

/**
 * Outfit-slot analysis: top/bottom/shoes/outerwear/accessory/fragrance.
 * Returns null if Vision unavailable or fails.
 */
export async function analyzeOutfitFromImageUrl(imageUrl: string): Promise<{
  slots: Record<string, VisionResult | null>;
  confidence: number;
  raw_notes: string | null;
  raw: any;
} | null> {
  try {
    const system = buildSystemPromptOutfit();
    const out = await callOpenAIJson(system, imageUrl);
    if (!out) return null;

    const parsed = out.parsed as OutfitVisionResponse;
    const slots = parsed?.slots ?? {};

    const slotKeys = ["top","bottom","shoes","outerwear","accessory","fragrance"] as const;

    const finalized: Record<string, VisionResult | null> = {};
    for (const k of slotKeys) {
      const v = (slots as any)?.[k];
      finalized[k] = v ? finalizeSingle(v, out.raw) : null;
    }

    const otherRaw = Array.isArray((slots as any)?.other) ? (slots as any).other.slice(0, 5) : [];
    if (otherRaw.length) {
      // We keep "other" inside raw only; you can ingest it if you want later.
    }

    return {
      slots: finalized,
      confidence: clamp01(parsed?.confidence, 0.5),
      raw_notes: safeString(parsed?.raw_notes),
      raw: { parsed, raw_response: out.raw },
    };
  } catch (err: any) {
    console.warn("Vision outfit failed:", err?.message ?? err);
    return null;
  }
}