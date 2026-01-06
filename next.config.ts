import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // IMPORTANT:
  // Do NOT use `output: "export"` because DRESZI needs API routes like /api/ingest

  // Ensure native binaries like ffmpeg-static are included in the serverless bundle.
  // Keys match ROUTE PATHS; values are globs relative to the project root.
  // See Next.js docs for output file tracing includes/excludes.
  outputFileTracingIncludes: {
    // ffmpeg is used by the processing route (frame extraction + candidate pipeline)
    "/api/wardrobe-videos/process": ["./node_modules/ffmpeg-static/**"],

    // Safety net: these routes import the same helpers in some environments
    "/api/wardrobe-videos/upload": ["./node_modules/ffmpeg-static/**"],
    "/api/wardrobe-videos": ["./node_modules/ffmpeg-static/**"],
  },
};

export default nextConfig;
