import type { NextConfig } from "next";

// NOTE:
// Next.js moved `experimental.outputFileTracingIncludes` to top-level `outputFileTracingIncludes`.
// Some Next.js type definitions lag behind this runtime option, so we cast the object to `any`
// while still keeping `satisfies NextConfig` for the rest of the config.
const nextConfig = ({
  // DRESZI needs API routes. Do NOT use `output: "export"`.

  // Ensure native binaries like ffmpeg-static are included in the serverless bundle.
  // Keys are route paths; values are globs resolved from the project root.
  outputFileTracingIncludes: {
    "/api/wardrobe-videos/process": ["./node_modules/ffmpeg-static/**"],
    "/api/wardrobe-videos/upload": ["./node_modules/ffmpeg-static/**"],

    // Include nested wardobe-videos API routes too (candidates, etc.)
    "/api/wardrobe-videos/**": ["./node_modules/ffmpeg-static/**"],
  },
} as any) satisfies NextConfig;

export default nextConfig;