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
  material: string | null;
  pattern: string | null;
  seasons: string[]; // e.g. ["winter","fall"]
  size: string | null;

  // Final tags (normalized)
  tags: string[];

  // Extra
  confidence: number; // 0..1
  raw_text: string | null;

  // Clean metadata for storage
  metadata: Record<string, any>;

  // Tracing
  provider: "openai";
  model: string | null;

  // Full raw response
  raw: any;
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

function clamp01(n: any, fallback = 0.6) {
  if (typeof n !== "number" || Number.isNaN(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function titleCase(s: string) {
  return s
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((w) => (w[0] ? w[0].toUpperCase() + w.slice(1) : w))
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
  // Typical Responses API locations
  if (typeof resJson?.output_text === "string") return resJson.output_text;

  const first = resJson?.output?.[0];
  const c0 = first?.content?.[0];

  if (typeof c0?.text === "string") return c0.text;
  if (typeof c0?.value === "string") return c0.value;

  return null;
}

function safeBaseColor(v: any): string | null {
  const c = safeString(v);
  if (!c) return null;

  const t = normTag(c);
  // Keep only allowed base colors (hard rule from your spec)
  const allowed = new Set([
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

  // Some common normalizations
  if (t.includes("grey")) return "gray";
  if (t.includes("navy")) return "navy";

  // If model returns something like "light gray", collapse to "gray"
  for (const a of allowed) {
    if (t.includes(a)) return a;
  }

  // If not in allowed list, return null (do not guess)
  return null;
}

function buildCatalogName(parsed: any) {
  // Desired: Brand + Color + Model (example: GAP Gray Relaxed Gap Logo Zip Hoodie)
  // If brand is null, skip it (no guessing).
  const brand = safeString(parsed?.brand);
  const color = safeBaseColor(parsed?.color);

  // model_name ONLY if clearly inferable, but we trust the model to obey the rule.
  // If null, we fall back to subcategory (still visually grounded).
  const model =
    safeString(parsed?.model_name) ||
    safeString(parsed?.subcategory) ||
    safeString(parsed?.garmentType);

  const parts = [brand, color, model].filter(Boolean) as string[];
  if (parts.length) return titleCase(parts.join(" "));

  // Fallback: if everything is missing
  const fallback =
    safeString(parsed?.catalog_name) ||
    safeString(parsed?.title) ||
    "Unknown Item";

  return titleCase(fallback);
}

function normalizePattern(v: any): string | null {
  const p = safeString(v);
  if (!p) return null;
  const t = normTag(p);

  const allowed = new Set([
    "solid",
    "stripes",
    "plaid",
    "camo",
    "logo/graphic",
    "check",
    "floral",
    "abstract",
    "heather",
    "colorblock",
    "text",
  ]);

  // Some common normalizations
  if (t.includes("logo") || t.includes("graphic")) return "logo/graphic";
  if (t.includes("stripe")) return "stripes";
  if (t.includes("camouflage")) return "camo";

  for (const a of allowed) {
    if (t === a) return a;
  }

  // If it is not one of the allowed patterns, do not guess.
  return null;
}

function enforceTagRules(tagsIn: string[]): string[] {
  // Enforce: lowercase, concise, nouns/adjectives, non-duplicate
  // We can't perfectly validate POS, but we can enforce format and dedupe.
  const cleaned = tagsIn
    .map((t) => normTag(String(t)))
    .filter(Boolean)
    .map((t) => t.replace(/[^\w\s/]+/g, "").trim()) // strip odd punctuation
    .filter(Boolean);

  return uniq(cleaned);
}

function finalizeVision(parsed: any, rawResponse: any): VisionResult {
  const rawNotes = safeString(parsed?.raw_notes);

  const pattern = normalizePattern(parsed?.pattern);
  const seasons = uniq(asStringArray(parsed?.seasons).map(normalizeSeason).filter(Boolean));

  // Base tags from model (12..25 required by prompt, but we enforce in code too)
  const baseTags = enforceTagRules(asStringArray(parsed?.tags));

  // Derived tags: keep these useful and consistent
  const derivedTags: string[] = [];

  if (pattern) derivedTags.push(pattern); // simple and useful
  for (const s of seasons) derivedTags.push(s); // "winter" instead of "season winter"

  // Include a few structured extras as tags (only if present)
  const extras = parsed?.extras && typeof parsed.extras === "object" ? parsed.extras : null;

  const closure = safeString(extras?.closure);
  const neckline = safeString(extras?.neckline);
  const length = safeString(extras?.length);
  const pockets = safeString(extras?.pockets);
  const logoPlacement = safeString(extras?.logo_placement);
  const hardware = safeString(extras?.hardware);

  const extraTags = enforceTagRules(
    [closure, neckline, length, pockets, logoPlacement, hardware].filter(Boolean) as string[]
  );

  // Combine tags and enforce size window (12..25)
  const combined = uniq([...baseTags, ...derivedTags, ...extraTags]);

  // If too few tags, add safe structural tags from garmentType/subcategory/material/color
  const fill: string[] = [];
  const gt = safeString(parsed?.garmentType);
  const sub = safeString(parsed?.subcategory);
  const mat = safeString(parsed?.material);
  const col = safeBaseColor(parsed?.color);

  if (gt) fill.push(normTag(gt));
  if (sub) fill.push(normTag(sub));
  if (mat) fill.push(normTag(mat));
  if (col) fill.push(normTag(col));

  const tags = uniq([...combined, ...fill]).slice(0, 25);

  // If still less than 12, keep what we have (do not invent)
  // (This should be rare if the prompt is followed.)
  const catalog_name = buildCatalogName(parsed);

  return {
    provider: "openai",
    model: safeString(rawResponse?.model) ?? "unknown",

    catalog_name,

    garmentType: safeString(parsed?.garmentType),
    subcategory: safeString(parsed?.subcategory),

    brand: safeString(parsed?.brand),
    color: safeBaseColor(parsed?.color),
    material: safeString(parsed?.material),
    pattern,
    seasons,
    size: safeString(parsed?.size),

    tags,

    confidence: clamp01(parsed?.confidence, 0.6),
    raw_text: rawNotes,

    metadata: {
      raw_notes: rawNotes,
      brand: safeString(parsed?.brand),
      color: safeBaseColor(parsed?.color),
      model_name: safeString(parsed?.model_name) ?? null,
      garmentType: safeString(parsed?.garmentType),
      subcategory: safeString(parsed?.subcategory),
      material: safeString(parsed?.material),
      pattern,
      seasons,
      size: safeString(parsed?.size),
      tags,
      extras: parsed?.extras ?? {},
    },

    raw: {
      parsed,
      raw_response: rawResponse,
    },
  };
}

/**
 * Official entry point used by /api/ingest
 * - If OPENAI_API_KEY missing or Vision fails: return null (ingest continues)
 */
export async function analyzeGarmentFromImageUrl(
  imageUrl: string
): Promise<VisionResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;

  // If missing key, do not break ingest. Return null.
  if (!apiKey) return null;

  const system = `
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
- brand: ONLY if clearly readable/identifiable from the image (logo text, unmistakable brand mark). Otherwise null.
- model_name: ONLY if clearly inferable (e.g., readable model text, iconic and unambiguous silhouette). Otherwise null (do NOT downgrade to a generic name here).
- catalog_name: optional; if unknown, set null (we will rebuild it).
- garmentType: the primary item type (examples: "hoodie", "t-shirt", "trousers", "sneakers", "handbag", "fragrance").
- subcategory: more specific than garmentType (examples: "zip hoodie", "crewneck sweatshirt", "running sneaker", "chelsea boot", "crossbody bag").
- color: simple base color only (e.g., "black", "white", "gray", "navy", "brown", "beige", "green", "red", "yellow", "purple", "pink", "orange", "blue"). If multicolor, use the dominant base color and note secondary colors in tags or extras.
- material: only if reasonably inferable (e.g., "denim", "leather", "suede", "knit", "mesh", "canvas"). Otherwise null.
- pattern: one of: "solid", "stripes", "plaid", "camo", "logo/graphic", "check", "floral", "abstract", "heather", "colorblock", "text". If unsure, null.
- seasons: choose 1–4 from the allowed list. Use best judgment based on warmth/coverage. If unknown, return an empty array [].
- size: ONLY if visible on a tag/label in the image. Otherwise null.

Tags requirements
- 12 to 25 tags.
- Tags must be lowercase, concise, nouns/adjectives, non-duplicate.
- Tags must be visually grounded (no "luxury", "designer", "limited", gender, or size guesses).
- Prefer useful details: silhouette, closures, neckline, sleeve length, sole type, hardware, pockets, logo placement, texture, finish.

Confidence
- confidence is a float 0.00–1.00 reflecting overall certainty across key fields.
- 0.90+ clear and unambiguous
- 0.60–0.89 mostly clear, some uncertainty
- 0.30–0.59 limited clarity
- <0.30 very unclear

raw_notes
- One short sentence describing what you saw (max ~20 words). No speculation.

extras
- Optional object for additional structured details when visible. Suggested keys:
  - "closure" (zip, buttons, lace-up, buckle, none)
  - "neckline" (crew, v-neck, collar, hood)
  - "length" (cropped, regular, longline)
  - "pockets" (none, side, chest, cargo)
  - "logo_placement" (chest, sleeve, heel, tongue, back, all-over)
  - "secondary_colors" (array)
  - "hardware" (gold, silver, matte, none)

Multi-item rule
If multiple products appear, analyze the primary item in focus and ignore the rest.
`.trim();

  try {
    const body = {
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Analyze this product photo and fill the JSON fields." },
            { type: "input_image", image_url: imageUrl },
          ],
        },
      ],
      // Responses API JSON formatting (replaces response_format)
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
      // Some variants may return JSON object directly
      const maybeObj = json?.output?.[0]?.content?.[0]?.json;
      if (maybeObj && typeof maybeObj === "object") parsed = maybeObj;
    }

    if (!parsed) return null;

    return finalizeVision(parsed, json);
  } catch (err: any) {
    console.warn("Vision failed (exception):", err?.message ?? err);
    return null;
  }
}