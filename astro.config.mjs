// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// GitHub Pages のプロジェクトページ運用前提。
// カスタムドメインにする場合は base を空文字に変更すること。
const repoName = "moshirasu";
const ghUser = process.env.GH_USER ?? "satory074";

export default defineConfig({
  site: `https://${ghUser}.github.io`,
  base: `/${repoName}`,
  trailingSlash: "ignore",
  vite: {
    // Tailwind v4 Vite plugin: cast to any to bridge Vite version typing mismatch
    plugins: [/** @type {any} */ (tailwindcss())],
  },
});
