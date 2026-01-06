import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // IMPORTANT:
  // Do NOT use `output: "export"` because DRESZI needs API routes like /api/ingest

  // Ensure native binaries like ffmpeg-static are included in the serverless bundle.
  // Keys match ROUTE PATHS; values are minimatch globs relative to the project root.
  outputFileTracingIncludes: {
    // ffmpeg is used by the processing route (frame extraction + candidate pipeline)
    "/api/wardrobe-videos/process": ["node_modules/ffmpeg-static/**"],

    // Safety net: these routes may import shared helpers that reference ffmpeg in some builds
    "/api/wardrobe-videos/upload": ["node_modules/ffmpeg-static/**"],
    "/api/wardrobe-videos": ["node_modules/ffmpeg-static/**"],
  },
};

export default nextConfig;
