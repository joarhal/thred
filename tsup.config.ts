import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  loader: {
    ".md": "text"
  },
  clean: true,
  sourcemap: false,
  splitting: false,
  shims: false,
  dts: false
});
