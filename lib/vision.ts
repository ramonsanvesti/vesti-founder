// lib/vision.ts
import "server-only";

export type VisionResult = {
  catalog_name: string;

  garmentType: string | null;
  subcategory: string | null;

  brand: string | null;
  color: string | null;
  material: string | null;
  size: string | null;

  tags: string[];

  confidence: number;
  raw_text: string | null;

  metadata: Record<string, any>;

  provider: "openai";
  model: string | null;

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

function clamp01(n: any, fallback = 0.65) {
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

function extractOutputText(resJson: any): string | null {
  // Responses API (texto agregado)
  if (typeof resJson?.output_text === "string") return resJson.output_text;

  // Fallbacks
  const first = resJson?.output?.[0];
  const c0 = first?.content?.[0];
  if (typeof c0?.text === "string") return c0.text;
  if (typeof c0?.value === "string") return c0.value;

  return null;
}

function finalizeVision(parsed: any, rawResponse: any): VisionResult {
  const tags = uniq((parsed?.tags ?? []).map((t: any) => normTag(String(t))))
    .filter(Boolean)
    .slice(0, 30);

  const brand = safeString(parsed?.brand);
  const color = safeString(parsed?.color);
  const garmentType = safeString(parsed?.garmentType);
  const subcategory = safeString(parsed?.subcategory);

  // Si Vision devuelve "catalog_name", bien. Si no, lo armamos.
  const catalogRaw =
    safeString(parsed?.catalog_name) ||
    safeString(parsed?.title) ||
    "Unknown Item";

  const rawNotes = safeString(parsed?.raw_notes);

  // Reforzar: si faltan tags, metemos algunos básicos útiles
  const boost: string[] = [];
  if (garmentType) boost.push(garmentType);
  if (subcategory) boost.push(subcategory);
  if (brand) boost.push(brand);
  if (color) boost.push(color);

  const finalTags = uniq([...tags, ...boost].map(normTag)).slice(0, 30);

  return {
    provider: "openai",
    model: safeString(rawResponse?.model) ?? "unknown",

    catalog_name: titleCase(catalogRaw),

    garmentType,
    subcategory,

    brand,
    color,
    material: safeString(parsed?.material),
    size: safeString(parsed?.size),

    tags: finalTags,

    confidence: clamp01(parsed?.confidence, 0.65),
    raw_text: rawNotes,

    metadata: {
      raw_notes: rawNotes,
      brand,
      color,
      material: safeString(parsed?.material),
      size: safeString(parsed?.size),
      garmentType,
      subcategory,
      tags: finalTags,
    },

    raw: {
      parsed,
      raw_response: rawResponse,
    },
  };
}

/**
 * Nombre “oficial” para usar desde /api/ingest
 * - Si falta OPENAI_API_KEY o Vision falla: devuelve null (no rompe ingest)
 */
export async function analyzeGarmentFromImageUrl(
  imageUrl: string
): Promise<VisionResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) return null;

  const system = `
You are VESTI Vision AI.
Analyze ONE product photo (clothing, shoes, accessories, or fragrance).

Return ONLY valid JSON. No markdown. No extra text.

Hard requirements:
	•	Produce 12 to 25 tags.
	•	Tags must be simple nouns/adjectives, lowercase, concise, and non-duplicate.
	•	Tags must be visually grounded (no guessing sizes, gender, era, “designer”, “luxury”, etc.).
	•	Include construction/details when visible (e.g., “zip”, “button”, “collar”, “hood”, “pockets”, “drawstring”, “logo”, “mesh”, “leather”, “knit”, “pleats”).
	•	If brand is not clearly visible, “brand”: null.
	•	If unsure about any field, prefer null over guessing.
	•	If multiple items appear, identify the primary product and ignore background items.
	•	If the photo is too unclear to classify, set category/subcategory/use_case to null, but still output the best tags you can from visible features.
`;

  // JSON Schema estricto para que SIEMPRE venga igual
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      catalog_name: { type: "string" },
      garmentType: { type: ["string", "null"] },
      subcategory: { type: ["string", "null"] },
      brand: { type: ["string", "null"] },
      color: { type: ["string", "null"] },
      material: { type: ["string", "null"] },
      size: { type: ["string", "null"] },
      tags: {
        type: "array",
        items: { type: "string" },
        minItems: 14,
        maxItems: 22,
      },
      confidence: { type: "number" },
      raw_notes: { type: ["string", "null"] },
    },
    required: ["catalog_name", "garmentType", "subcategory", "brand", "color", "material", "size", "tags", "confidence", "raw_notes"],
  };

  try {
    const body = {
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Extract fields. catalog_name must be short, catalog style, Title Case. Prefer: Brand + Color + Model when possible.",
            },
            { type: "input_image", image_url: imageUrl },
          ],
        },
      ],

      // ✅ Nuevo formato para Responses API
      text: {
        format: {
          type: "json_schema",
          name: "vesti_vision",
          schema,
          strict: true,
        },
      },
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
    if (!outputText) {
      // rarísimo, pero por si acaso
      const maybeObj = json?.output?.[0]?.content?.[0]?.json;
      if (maybeObj && typeof maybeObj === "object") {
        return finalizeVision(maybeObj, json);
      }
      console.warn("Vision: no output_text");
      return null;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      console.warn("Vision output was not valid JSON:", outputText);
      return null;
    }

    return finalizeVision(parsed, json);
  } catch (err: any) {
    console.warn("Vision failed (exception):", err?.message ?? err);
    return null;
  }
}