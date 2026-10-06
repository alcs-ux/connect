/**
 * 書体を public/fonts にコピーし、1枚のCSS（public/fonts/fonts.css）にまとめる。
 * 日本語フォントは約120個のサブセットに分かれており、webpack経由で読み込むと
 * CSSの解析が重くなりビルドが不安定になるため、静的ファイルとして配信する。
 * `npm run dev` / `npm run build` の前に自動で実行される（package.json の predev / prebuild）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "fonts");
const FAMILIES = [
  { pkg: "@fontsource/ibm-plex-sans", weights: [400, 500, 600] },
  { pkg: "@fontsource/ibm-plex-sans-jp", weights: [400, 500, 600] },
  { pkg: "@fontsource/zen-old-mincho", weights: [500] },
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let css = "/* 自動生成：scripts/build-fonts.mjs。直接編集しないでください。 */\n";
let files = 0;

for (const { pkg, weights } of FAMILIES) {
  const dir = join(root, "node_modules", pkg);
  for (const w of weights) {
    const src = readFileSync(join(dir, `${w}.css`), "utf8");
    // woff2 のみ残す（対応ブラウザは十分に広い）。url を /fonts/ 配下に書き換える。
    css += src.replace(/src:\s*url\(\.\/files\/([^)]+\.woff2)\)\s*format\(['"]woff2['"]\)(?:\s*,\s*url\([^)]+\)\s*format\(['"]woff['"]\))?/g, (_, file) => {
      const from = join(dir, "files", file);
      if (existsSync(from)) { copyFileSync(from, join(out, file)); files++; }
      return `src: url(/fonts/${file}) format("woff2")`;
    });
  }
}
writeFileSync(join(out, "fonts.css"), css);
console.log(`fonts: ${files} files → public/fonts`);
