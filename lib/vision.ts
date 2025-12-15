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

  // Jerarquía nueva
  fit: string | null; // oversized, relaxed, slim, regular
  use_case: string | null; // casual, streetwear, work, athletic
  use_case_tags: string[]; // text[]

  // Modelo “humano”
  model: string | null; // "Gap Logo Zip Hoodie", etc.

  // Tags final (normalizados)
  tags: string[];

  // Extra
  confidence: number; // 0..1
  raw_text: string | null;

  // Para metadata.vision
  metadata: Record<string, any>;

  // Para trazabilidad
  provider: "openai";
  model_id: string | null;

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

function titleCaseLoose(s: string) {
  return s
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

function joinParts(parts: Array<string | null | undefined>) {
  return parts.map((p) => (p ?? "").trim()).filter(Boolean).join(" ");
}

function cleanBrand(b: string | null) {
  if (!b) return null;
  const t = b.trim();
  if (!t) return null;
  if (t.toLowerCase() === "gap") return "GAP";
  return t;
}

function normEnumLike(s: string | null) {
  if (!s) return null;
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

function extractOutputText(resJson: any): string | null {
  // Responses API puede devolver output_text o dentro de output[0].content[0].text
  if (typeof resJson?.output_text === "string") return resJson.output_text;

  const first = resJson?.output?.[0];
  const c0 = first?.content?.[0];

  if (typeof c0?.text === "string") return c0.text;
  if (typeof c0?.value === "string") return c0.value;

  return null;
}

function extractModelId(resJson: any): string | null {
  return safeString(resJson?.model);
}

function finalizeVision(parsed: any, rawResponse: any): VisionResult {
  const tags = uniq((parsed?.tags ?? []).map((t: any) => normTag(String(t)))).slice(
    0,
    30
  );

  const brand = cleanBrand(safeString(parsed?.brand));
  const colorRaw = safeString(parsed?.color);
  const color = colorRaw ? titleCaseLoose(colorRaw) : null;

  const fitRaw = safeString(parsed?.fit);
  const fit = fitRaw ? titleCaseLoose(fitRaw) : null;

  const useCaseRaw = safeString(parsed?.use_case);
  const use_case = useCaseRaw ? normEnumLike(useCaseRaw) : null;

  const useCaseTags = uniq(
    (parsed?.use_case_tags ?? [])
      .map((t: any) => normTag(String(t)))
      .filter(Boolean)
  ).slice(0, 20);

  const modelRaw =
    safeString(parsed?.model) ||
    safeString(parsed?.subcategory) ||
    safeString(parsed?.garmentType) ||
    "Item";
  const model = titleCaseLoose(modelRaw);

  // Brand + Color + Fit + Model
  const catalog_name = joinParts([brand, color, fit, model]) || "Unknown Item";

  const rawNotes = safeString(parsed?.raw_notes);

  return {
    provider: "openai",
    model_id: extractModelId(rawResponse) ?? "unknown",

    catalog_name,

    garmentType: safeString(parsed?.garmentType),
    subcategory: safeString(parsed?.subcategory),

    brand,
    color: colorRaw,
    material: safeString(parsed?.material),
    size: safeString(parsed?.size),

    fit: fitRaw ? normEnumLike(fitRaw) : null,
    use_case,
    use_case_tags: useCaseTags,

    model: modelRaw,

    tags,

    confidence: clamp01(parsed?.confidence, 0.6),
    raw_text: rawNotes,

    metadata: {
      raw_notes: rawNotes,
      tags,
      brand,
      color: colorRaw,
      material: safeString(parsed?.material),
      size: safeString(parsed?.size),
      model: modelRaw,
      fit: fitRaw ? normEnumLike(fitRaw) : null,
      use_case,
      use_case_tags: useCaseTags,
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
You are VESTI Vision AI. Analyze a single product photo (clothing, shoes, accessories, or fragrance).
Return ONLY valid JSON (no markdown, no commentary).

Return JSON with these keys:
- brand: string|null (only if clearly visible)
- color: string|null (main color(s) in simple terms)
- garmentType: string|null (e.g. "hoodie", "sneakers", "trousers", "beanie", "perfume bottle")
- subcategory: string|null (more specific type if possible)
- model: string|null (concise model name with distinguishing features; e.g. "Gap Logo Zip Hoodie")
- fit: one of ["oversized","relaxed","slim","regular"] or null
- use_case: one of ["casual","streetwear","work","athletic"] or null
- use_case_tags: array of 3-8 tags aligned to use_case (e.g. ["layering","everyday","errands"])
- material: string|null
- size: string|null (only if visible)
- tags: 6-14 concise tags (nouns/adjectives). No duplicates.
- confidence: number 0..1
- raw_notes: one short sentence about what you saw.
`;

  try {
    const body = {
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Analyze this image and extract the fields as JSON." },
            { type: "input_image", image_url: imageUrl },
          ],
        },
      ],
      // IMPORTANT: Responses API usa text.format (no response_format)
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
      // fallback: algunas variantes podrían traer json directo
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
