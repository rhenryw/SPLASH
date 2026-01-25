import { defineConfig } from "vite";

export default defineConfig({
  assetsInclude: ["**/*.wasm", "**/*.wasm.wasm"],
  plugins: [
    {
      name: "wasm-url-fallback",
      enforce: "pre",
      resolveId(id) {
        if (id.endsWith(".wasm") || id.endsWith(".wasm.wasm")) {
          return id + "?url";
        }
        return null;
      },
    },
  ],
});
