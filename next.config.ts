import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // IMPORTANT:
  // Do NOT use `output: "export"` because DRESZI needs API routes like /api/ingest

  // Ensure native binaries like ffmpeg-static are included in the serverless bundle.
  // Without this, Vercel can deploy the function without the ffmpeg binary, causing spawn ENOENT.
  // Note: `outputFileTracingIncludes` is a top-level config key (not under `experimental`).
  outputFileTracingIncludes: {
    // App Router route path (this is what Vercel/Next traces for the serverless entrypoint)
    "/api/wardrobe-videos/process": [
      "node_modules/ffmpeg-static/**",
      "node_modules/ffmpeg-static/ffmpeg",
    ],

    // Safety net: any wardrobe-videos API route that may call ffmpeg helpers
    "/api/wardrobe-videos/**": [
      "node_modules/ffmpeg-static/**",
      "node_modules/ffmpeg-static/ffmpeg",
    ],
  },
};

export default nextConfig;
