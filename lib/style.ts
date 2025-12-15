// lib/style.ts
import type { VestiCategory } from "@/lib/category";

function norm(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function uniqStrings(arr: string[]) {
  return Array.from(new Set(arr.map(norm).filter(Boolean)));
}

export type UseCaseTag =
  | "casual"
  | "streetwear"
  | "work"
  | "athletic"
  | "formal"
  | "winter"
  | "summer"
  | "travel"
  | "lounge";

function uniqUseCase(arr: UseCaseTag[]) {
  return Array.from(new Set(arr));
}

export function inferFit(input: { tags?: string[]; title?: string | null }): string {
  const tags = uniqStrings(input.tags ?? []);
  const title = norm(input.title ?? "");
  const blob = `${title} ${tags.join(" ")}`.trim();

  if (blob.includes("oversized") || blob.includes("over sized") || blob.includes("boxy")) return "oversized";
  if (blob.includes("relaxed") || blob.includes("loose") || blob.includes("roomy") || blob.includes("comfort")) return "relaxed";
  if (blob.includes("slim") || blob.includes("fitted") || blob.includes("tailored")) return "slim";

  return "regular";
}

export function inferUseCaseTags(input: {
  tags?: string[];
  category?: VestiCategory | null;
  subcategory?: string | null;
  title?: string | null;
}): UseCaseTag[] {
  const tags = uniqStrings(input.tags ?? []);
  const title = norm(input.title ?? "");
  const sub = norm(input.subcategory ?? "");
  const blob = `${title} ${sub} ${tags.join(" ")}`.trim();

  const out: UseCaseTag[] = [];

  // Athletic
  if (
    blob.includes("athletic") ||
    blob.includes("performance") ||
    blob.includes("training") ||
    blob.includes("gym") ||
    blob.includes("running") ||
    blob.includes("trail") ||
    blob.includes("athleisure")
  ) out.push("athletic");

  // Work
  if (
    blob.includes("office") ||
    blob.includes("business") ||
    blob.includes("blazer") ||
    blob.includes("trousers") ||
    blob.includes("dress shirt") ||
    blob.includes("oxford") ||
    blob.includes("button up") ||
    blob.includes("button-up") ||
    blob.includes("tailored") ||
    blob.includes("smart casual") ||
    blob.includes("smart-casual")
  ) out.push("work");

  // Formal
  if (
    blob.includes("formal") ||
    blob.includes("suit") ||
    blob.includes("tux") ||
    blob.includes("evening") ||
    blob.includes("dress shoe") ||
    blob.includes("heels")
  ) out.push("formal");

  // Streetwear (más específico, menos trigger fácil)
  if (
    blob.includes("streetwear") ||
    blob.includes("graphic tee") ||
    blob.includes("graphic") ||
    blob.includes("hoodie") ||
    blob.includes("cargo") ||
    blob.includes("oversized") ||
    blob.includes("essential") ||
    blob.includes("drawstring")
  ) out.push("streetwear");

  // Lounge
  if (
    blob.includes("lounge") ||
    blob.includes("pajama") ||
    blob.includes("sweatpant") ||
    blob.includes("sweatpants") ||
    blob.includes("jogger") ||
    blob.includes("joggers") ||
    blob.includes("fleece")
  ) out.push("lounge");

  // Winter
  if (
    blob.includes("winter") ||
    blob.includes("coat") ||
    blob.includes("puffer") ||
    blob.includes("parka") ||
    blob.includes("beanie") ||
    blob.includes("wool") ||
    blob.includes("thermal")
  ) out.push("winter");

  // Summer
  if (
    blob.includes("summer") ||
    blob.includes("shorts") ||
    blob.includes("linen") ||
    blob.includes("tank") ||
    blob.includes("sandals") ||
    blob.includes("slides")
  ) out.push("summer");

  // Travel
  if (blob.includes("travel") || blob.includes("packable")) out.push("travel");

  // Ayudas por categoría
  if (input.category === "outerwear") {
    if (!out.includes("winter") && (blob.includes("puffer") || blob.includes("parka") || blob.includes("coat"))) out.push("winter");
  }

  if (input.category === "shoes") {
    if (!out.includes("athletic") && (blob.includes("sneaker") || blob.includes("running") || blob.includes("trainer"))) out.push("athletic");
    if (!out.includes("formal") && (blob.includes("loafer") || blob.includes("oxford") || blob.includes("derby"))) out.push("formal");
  }

  // Casual solo si el texto lo sugiere o si no hay nada más
  if (blob.includes("casual") || blob.includes("everyday") || blob.includes("daily")) {
    out.push("casual");
  }

  const deduped = uniqUseCase(out);

  if (deduped.length === 0) return ["casual"];

  return deduped;
}

export function pickPrimaryUseCase(tags: UseCaseTag[]): UseCaseTag {
  const priority: UseCaseTag[] = ["athletic", "work", "formal", "streetwear", "winter", "summer", "travel", "lounge", "casual"];
  for (const p of priority) if (tags.includes(p)) return p;
  return "casual";
}