import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The per-track sweeps (terrain trap scans, kerb-run bands, AI laps)
    // grow with the roster - 27 circuits now, and several scan-based
    // terrain tests take 10-20s alone. The vitest default of 5s only
    // holds when those files run in isolation; it flakes under full-suite
    // worker contention.
    testTimeout: 20000,
  },
});
