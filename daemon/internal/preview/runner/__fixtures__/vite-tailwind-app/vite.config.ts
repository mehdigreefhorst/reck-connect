import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Real project config: the reck runner auto-loads this verbatim, so the `@`
// alias and the React plugin must be honoured for the target module to
// transform and resolve correctly. Tailwind is wired via PostCSS
// (postcss.config.js) so no native bindings are required.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
});
