// lib/style.ts
import type { VestiCategory } from "@/lib/category";

function norm(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
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

const USE_CASE_SET = new Set<UseCaseTag>([
  "casual",
  "streetwear",
  "work",
  "athletic",
  "formal",
  "winter",
  "summer",
  "travel",
  "lounge",
]);

function uniqStrings(arr: string[]) {
  return Array.from(new Set(arr.map(norm).filter(Boolean)));
}

function uniqUseCaseTags(arr: UseCaseTag[]): UseCaseTag[] {
  // uniq + mantiene el tipo
  return Array.from(new Set(arr));
}

function asUseCaseTag(v: string): UseCaseTag | null {
  const n = norm(v) as UseCaseTag;
  return USE_CASE_SET.has(n) ? n : null;
}

export function inferFit(input: { tags?: string[]; title?: string | null }): string {
  const tags = uniqStrings(input.tags ?? []);
  const title = norm(input.title ?? "");
  const blob = `${title} ${tags.join(" ")}`.trim();

  if (blob.includes("oversized") || blob.includes("over sized") || blob.includes("boxy"))
    return "oversized";
  if (blob.includes("relaxed") || blob.includes("loose") || blob.includes("roomy") || blob.includes("comfort"))
    return "relaxed";
  if (blob.includes("slim") || blob.includes("fitted") || blob.includes("tailored"))
    return "slim";

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
    blob.includes("athleisure")
  ) out.push("athletic");

  // Work
  if (
    blob.includes("work") ||
    blob.includes("office") ||
    blob.includes("business") ||
    blob.includes("blazer") ||
    blob.includes("trousers") ||
    blob.includes("dress") ||
    blob.includes("oxford") ||
    blob.includes("button up") ||
    blob.includes("button-up") ||
    blob.includes("tailored")
  ) out.push("work");

  // Formal
  if (
    blob.includes("formal") ||
    blob.includes("suit") ||
    blob.includes("tux") ||
    blob.includes("evening")
  ) out.push("formal");

  // Streetwear
  if (
    blob.includes("streetwear") ||
    blob.includes("logo") ||
    blob.includes("graphic") ||
    blob.includes("drawstring") ||
    blob.includes("hoodie") ||
    blob.includes("cargo") ||
    blob.includes("oversized")
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

  // Winter / Summer
  if (
    blob.includes("winter") ||
    blob.includes("coat") ||
    blob.includes("puffer") ||
    blob.includes("parka") ||
    blob.includes("beanie") ||
    blob.includes("fleece") ||
    blob.includes("wool")
  ) out.push("winter");

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

  // Default
  if (out.length === 0) out.push("casual");
  else if (!out.includes("casual")) out.push("casual");

  // Si vinieran tags externos (por ejemplo manuales), los aceptamos SOLO si son válidos
  // (esto te salva si más adelante mezclas strings)
  const extra: UseCaseTag[] = [];
  for (const t of tags) {
    const maybe = asUseCaseTag(t);
    if (maybe) extra.push(maybe);
  }

  return uniqUseCaseTags([...out, ...extra]);
}

export function pickPrimaryUseCase(tags: UseCaseTag[]): UseCaseTag {
  const priority: UseCaseTag[] = [
    "athletic",
    "work",
    "streetwear",
    "formal",
    "winter",
    "summer",
    "travel",
    "lounge",
    "casual",
  ];
  for (const p of priority) if (tags.includes(p)) return p;
  return "casual";
}