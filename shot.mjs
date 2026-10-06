// 画面確認用スクリーンショット： node scripts/shot.mjs <base> <path> <name> [mobile|desktop] [demo|admin|none] [full]
import { chromium } from "playwright";
const [base, path, name, device = "mobile", login = "none", full = "full"] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-proxy-server", "--disable-background-networking"] });
const ctx = await browser.newContext(device === "mobile"
  ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ja-JP" }
  : { viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1, locale: "ja-JP" });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
if (login !== "none") {
  await page.goto(base + "/login", { waitUntil: "load" });
  await page.getByRole("button", { name: login === "admin" ? /運営画面/ : /デモアカウント/ }).click();
  await page.waitForURL(/\/(home|admin)/, { timeout: 15000 });
}
await page.goto(base + path, { waitUntil: "load" });
await page.waitForTimeout(1800);
await page.screenshot({ path: `scripts/shots/${name}.png`, fullPage: full === "full" });
if (errors.length) console.log("CONSOLE ERRORS:", errors.slice(0, 5));
console.log("ok", name);
await browser.close();
