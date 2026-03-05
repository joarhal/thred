import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "raw-md-loader",
      enforce: "pre",
      transform(src, id) {
        if (!id.endsWith(".md")) {
          return null;
        }
        return {
          code: `export default ${JSON.stringify(src)};`,
          map: null
        };
      }
    }
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["test-projects/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["test-projects/**", "src/types.ts", "src/types/**/*.d.ts"],
      thresholds: {
        lines: 83,
        functions: 93,
        statements: 83,
        branches: 78
      }
    }
  }
});
