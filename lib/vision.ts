// lib/vision.ts
import "server-only";

export type VisionResult = {
  // Lo que tu UI y DB necesitan
  catalog_name: string;

  // Raw-ish para luego normalizar category/subcategory
  garmentType: string | null;
  subcategory: string | null;

  // Atributos
  brand: string | null;
  color: string | null;
  material: string | null;
  size: string | null;

  // Tags final (normalizados)
  tags: string[];

  // Extra
  confidence: number; // 0..1
  raw_text: string | null;

  // Para metadata.vision
  metadata: Record<string, any>;

  // Para trazabilidad
  provider: "openai";
  model: string | null;

  // Respuesta raw completa
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
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

function extractOutputText(resJson: any): string | null {
  // Respuestas típicas en Responses API
  if (typeof resJson?.output_text === "string") return resJson.output_text;

  const first = resJson?.output?.[0];
  const c0 = first?.content?.[0];

  if (typeof c0?.text === "string") return c0.text;
  if (typeof c0?.value === "string") return c0.value;

  return null;
}

function finalizeVision(parsed: any, rawResponse: any): VisionResult {
  const tags = uniq((parsed?.tags ?? []).map((t: any) => normTag(String(t)))).slice(0, 30);

  const catalog =
    safeString(parsed?.catalog_name) ||
    safeString(parsed?.title) ||
    "Unknown Item";

  const rawNotes = safeString(parsed?.raw_notes);

  return {
    provider: "openai",
    model: safeString(rawResponse?.model) ?? "unknown",

    catalog_name: titleCase(catalog),

    garmentType: safeString(parsed?.garmentType),
    subcategory: safeString(parsed?.subcategory),

    brand: safeString(parsed?.brand),
    color: safeString(parsed?.color),
    material: safeString(parsed?.material),
    size: safeString(parsed?.size),

    tags,

    confidence: clamp01(parsed?.confidence, 0.6),
    raw_text: rawNotes,

    metadata: {
      // aquí puedes agregar campos extra que quieras guardar “limpios”
      raw_notes: rawNotes,
      tags,
      brand: safeString(parsed?.brand),
      color: safeString(parsed?.color),
      material: safeString(parsed?.material),
      size: safeString(parsed?.size),
    },

    raw: {
      parsed,
      raw_response: rawResponse,
    },
  };
}

/**
 * Nombre “oficial” para usar desde /api/ingest
 */
export async function analyzeGarmentFromImageUrl(
  imageUrl: string
): Promise<VisionResult | null> {
  const apiKey = process.env.OPENAI_API_KEY;

  // Si no hay key, no rompemos ingest: devolvemos null y route.ts hace fallback
  if (!apiKey) return null;

  const system = `
You are VESTI Vision AI. Analyze a single product photo (clothing, shoes, accessories, or fragrance).
Return ONLY valid JSON (no markdown, no commentary).

Output schema:
{
  "catalog_name": "Title Case 3-6 words",
  "garmentType": "free text type",
  "subcategory": "more specific type or null",
  "brand": "brand if clearly visible else null",
  "color": "main color(s) simple terms or null",
  "material": "material if reasonably inferable else null",
  "size": "size if visible (S/M/L/XL/number) else null",
  "tags": ["6-14 concise tags, nouns/adjectives, lowercase ok, no duplicates"],
  "confidence": 0.0-1.0,
  "raw_notes": "one short sentence describing what you saw"
}

Rules:
- catalog_name MUST be short and catalog-style.
- tags MUST be concise and useful for filtering.
- If unsure, use null rather than guessing brand/material/size.
`;

  const body = {
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Analyze this image and extract the JSON fields." },
          { type: "input_image", image_url: imageUrl },
        ],
      },
    ],
    response_format: { type: "json_object" },
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
    throw new Error(`Vision request failed: ${res.status} ${txt}`);
  }

  const json = await res.json();

  // 1) intentamos output_text
  const outputText = extractOutputText(json);

  // 2) fallback: algunos outputs vienen como objeto ya
  const maybeObj = json?.output?.[0]?.content?.[0]?.json;

  if (!outputText && maybeObj && typeof maybeObj === "object") {
    return finalizeVision(maybeObj, json);
  }

  if (!outputText || typeof outputText !== "string") {
    throw new Error("Vision returned no parsable output");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw new Error("Vision output was not valid JSON");
  }

  return finalizeVision(parsed, json);
}
