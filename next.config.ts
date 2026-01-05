import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // IMPORTANT:
  // Do NOT use `output: "export"` because DRESZI needs API routes like /api/ingest

  // Ensure native binaries like ffmpeg-static are included in the serverless bundle.
  // Without this, Vercel can deploy the function without the ffmpeg binary, causing spawn ENOENT.
  // Note: `outputFileTracingIncludes` is a top-level config key (not under `experimental`).
  outputFileTracingIncludes: {
    "/api/wardrobe-videos/process": ["./node_modules/ffmpeg-static/**"],
    "/app/api/wardrobe-videos/process/route": ["./node_modules/ffmpeg-static/**"],
},
  },
};

export default nextConfig;
