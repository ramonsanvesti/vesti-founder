function normTag(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ");
}

const STOPWORDS = new Set([
  "the","a","an","and","or","with","for","to","of","in","on","by",
  "men","mens","women","womens","unisex","kids","kid","youth",
  "size","new","authentic","original",
]);

const COLORS = new Set([
  "black","white","gray","grey","navy","brown","beige","green","red","yellow","purple","pink","orange","blue","tan","cream","off","offwhite","off-white",
]);

function uniq(arr: string[]) {
  return Array.from(new Set(arr.map((x) => x.trim()).filter(Boolean)));
}

/**
 * Build tags from free text when Vision is unavailable.
 * Goal: produce visually-agnostic but still useful tags for filtering and rules-based outfits.
 * Returns 12–25 tags when possible.
 */
function tagsFromTextQuery(q: string): string[] {
  const cleaned = normTag(q);
  if (!cleaned) return [];

  const tokens = cleaned.split(" ").filter(Boolean);

  // Keep multiword phrases that are very useful as tags
  const phrases: string[] = [];
  const blob = ` ${cleaned} `;

  const maybePhrases = [
    "zip hoodie",
    "zip up",
    "full zip",
    "half zip",
    "quarter zip",
    "crewneck sweatshirt",
    "crewneck",
    "button up",
    "t shirt",
    "tee shirt",
    "sweat pants",
    "track pants",
    "running shoe",
    "running sneaker",
    "crossbody bag",
  ];

  for (const p of maybePhrases) {
    if (blob.includes(` ${p} `)) phrases.push(p);
  }

  const out: string[] = [];

  // Colors (single token)
  for (const t of tokens) {
    if (COLORS.has(t)) out.push(t === "grey" ? "gray" : t);
  }

  // Core garment keywords (safe even from text)
  const KEYWORDS = [
    "hoodie","sweatshirt","crewneck","sweater","tee","tshirt","shirt","button","oxford",
    "jacket","coat","puffer","blazer","trench",
    "pants","trousers","jeans","denim","joggers","shorts",
    "sneakers","shoes","boots","loafers","sandals","slides",
    "beanie","cap","hat","belt","bag","backpack","wallet","sunglasses",
    "logo","graphic","zip","zipper","drawstring","pocket","collar","hood",
    "relaxed","oversized","slim","regular",
  ];

  const setTokens = new Set(tokens);
  for (const k of KEYWORDS) {
    if (setTokens.has(k)) out.push(k);
  }

  // Add phrases last (they're strong)
  out.push(...phrases);

  // Add remaining meaningful tokens (skip stopwords + numbers)
  for (const t of tokens) {
    if (STOPWORDS.has(t)) continue;
    if (/^\d+$/.test(t)) continue;
    if (t.length <= 2) continue;
    // Avoid noisy brand/model tokens? Keep them if you want.
    out.push(t);
  }

  // Normalize + dedupe + keep within 12-25 if possible
  const final = uniq(out.map(normTag)).filter(Boolean);

  // Prefer 12–25 tags, but never force garbage; cap at 25
  return final.slice(0, 25);
}