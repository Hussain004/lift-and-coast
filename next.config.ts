import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // StrictMode's dev-only double-mount tears down and rebuilds the Rapier
  // WASM world; any component holding a ref into the old world crashes on
  // the next physics/render tick. Standard tradeoff for canvas+WASM apps.
  reactStrictMode: false,
};

export default nextConfig;
