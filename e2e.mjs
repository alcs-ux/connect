/**
 * 画面を通しで操作して確認する（デモモード）： node scripts/e2e.mjs [baseURL]
 *  1. 新規登録 → オンボーディング全問 → 分析 → ホーム
 *  2. 「話してみたい」→ 相手の承認 → 紹介成立 → 連絡先
 *  3. ネットワーク検索、プロフィール、通知、運営画面
 * 各画面のスクリーンショットを scripts/shots/ に保存し、コンソールエラーがあれば失敗にする。
 */
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3100";
const exe = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: exe, args: ["--no-proxy-server", "--disable-background-networking"] });
const problems = [];
const steps = [];

async function session(device) {
  const ctx = await browser.newContext(device === "mobile"
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ja-JP" }
    : { viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1, locale: "ja-JP" });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" && !/favicon/.test(m.text())) problems.push(`[console] ${page.url()} ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`[pageerror] ${page.url()} ${e}`));
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("_rsc")) problems.push(`[http ${r.status()}] ${r.url()}`); });
  const shot = async (name, full = true) => { await page.waitForTimeout(500); await page.screenshot({ path: `scripts/shots/${name}.png`, fullPage: full }); steps.push(name); };
  return { ctx, page, shot };
}
const ok = (cond, msg) => { if (!cond) problems.push(`[assert] ${msg}`); };

/* ── 1. 新規登録とオンボーディング（スマホ） ── */
{
  const { ctx, page, shot } = await session("mobile");
  await page.goto(base + "/signup", { waitUntil: "load" });
  await shot("m-01-signup");
  await page.getByRole("button", { name: "メールアドレスで登録" }).click();
  await page.waitForTimeout(300);
  await shot("m-02-signup-errors");
  await page.getByLabel("メールアドレス").fill("minami@minami-sekkei.example.jp");
  await page.getByLabel("パスワード").fill("password-1234");
  await page.getByRole("button", { name: "メールアドレスで登録" }).click();
  await page.waitForURL(/onboarding/);
  await page.getByRole("button", { name: "はじめる" }).waitFor();
  await shot("m-03-welcome");
  await page.getByRole("button", { name: "はじめる" }).click();
  await shot("m-04-card");
  // 名刺画像をアップロード（見本の読み取り結果が入る）
  await page.locator('input[type=file]').nth(1).setInputFiles("scripts/fixtures/card.png");
  await page.getByRole("heading", { name: "内容を確認してください" }).waitFor({ timeout: 15000 });
  await shot("m-05-profile");
  await page.getByRole("button", { name: "はい、決裁者です" }).click();
  await page.getByRole("button", { name: "次へ" }).click();
  await page.getByRole("heading", { name: "会社について教えてください" }).waitFor();
  await page.getByRole("button", { name: "次へ" }).click(); // 未入力エラーを確認
  await shot("m-06-company-errors");
  await page.getByLabel("業種").selectOption("construction");
  await page.getByRole("button", { name: "2〜10名" }).click();
  await page.getByLabel("設立年").fill("2012");
  await shot("m-07-company");
  await page.getByRole("button", { name: "次へ" }).click();
  await page.getByLabel("事業内容を一行で").fill("店舗・オフィスの設計と内装デザイン");
  await page.getByLabel("会社紹介").fill("飲食店・美容サロン・オフィスの設計を専門とする設計事務所です。物件探しの段階から関わり、施工会社と連携して開業まで伴走します。");
  await page.getByLabel("提供サービスを追加").fill("店舗設計");
  await page.getByRole("button", { name: "追加" }).click();
  await page.getByLabel("提供サービスを追加").fill("オフィス設計");
  await page.getByRole("button", { name: "追加" }).click();
  await page.getByRole("button", { name: "東京", exact: true }).click();
  await shot("m-08-about");
  await page.getByRole("button", { name: "次へ" }).click();
  await page.getByRole("heading", { name: "いま、もっとも欲しいものは？" }).waitFor();
  await page.getByRole("button", { name: "新規顧客" }).click();
  await page.getByRole("button", { name: "業務提携先" }).click();
  await page.getByRole("button", { name: /Web・マーケティング/ }).click();
  await shot("m-09-q1");
  await page.getByRole("button", { name: "次へ" }).click();
  for (const n of ["飲食", "美容・サロン", "不動産"]) await page.getByRole("button", { name: n, exact: true }).click();
  await shot("m-10-q2");
  await page.getByRole("button", { name: "次へ" }).click();
  await page.getByRole("button", { name: "次へ" }).click(); // 規模・地域はこだわらない
  await page.getByRole("button", { name: "売上・新規開拓が伸びない" }).click();
  await page.getByRole("button", { name: "Webからの問い合わせが少ない" }).click();
  await page.getByRole("button", { name: "次へ" }).click();
  await page.getByRole("heading", { name: "いつごろ商談したいですか" }).waitFor();
  await shot("m-11-q4");
  await page.getByRole("button", { name: "1ヶ月以内" }).click(); // 自動で次へ
  await page.getByRole("heading", { name: "予算の目安はありますか" }).waitFor();
  await page.getByRole("button", { name: "案件ごとに相談" }).click();
  await page.getByRole("heading", { name: "どんな会社を紹介してほしいですか" }).waitFor();
  await page.getByRole("button", { name: /顧客を相互に紹介し合える/ }).click();
  await shot("m-12-q6");
  await page.getByRole("button", { name: "次へ" }).click();
  await page.getByRole("button", { name: "内装・建築・設備工事" }).click();
  await page.getByRole("button", { name: "顧客・取引先の紹介" }).click();
  await shot("m-13-q7");
  await page.getByRole("button", { name: "次へ" }).click();
  await page.getByRole("button", { name: "登録した提供サービスを入れる" }).click();
  await page.getByRole("button", { name: "次へ" }).click();
  await page.getByRole("button", { name: "飲食", exact: true }).click();
  await page.getByRole("button", { name: "次へ" }).click();
  await page.getByRole("button", { name: "積極的に紹介してほしい" }).click();
  await shot("m-14-q13");
  await page.getByRole("button", { name: "次へ" }).click();
  await page.getByRole("heading", { name: "登録内容の確認" }).waitFor();
  await page.getByRole("button", { name: "登録して候補を見る" }).click(); // 同意なしのエラー
  await page.waitForTimeout(200);
  for (const t of ["利用目的に同意する", "他の利用者への表示に同意する", "連絡先の開示に同意する"]) await page.getByText(t).click();
  await shot("m-15-confirm");
  await page.getByRole("button", { name: "登録して候補を見る" }).click();
  await page.getByText("あなたに合う企業を探しています。").waitFor();
  await page.waitForTimeout(1300);
  await shot("m-16-analyzing", false);
  await page.getByRole("heading", { name: /社の候補が見つかりました/ }).waitFor({ timeout: 20000 });
  await shot("m-17-found", false);
  await page.getByRole("button", { name: "おすすめを見る" }).click();
  await page.waitForURL(/home/);
  await page.getByRole("heading", { name: "あなたへのおすすめ" }).waitFor();
  await page.waitForTimeout(1200);
  await shot("m-18-home-new");

  /* ── 2. 話してみたい → 承認 → 成立 ── */
  await page.locator('a[href^="/matches/"]').first().click();
  await page.getByRole("heading", { name: "相性が良い理由" }).waitFor();
  await shot("m-19-match-detail");
  await page.getByRole("button", { name: "話してみたい" }).click();
  await page.locator("p:visible", { hasText: "相手の回答を待っています" }).first().waitFor({ timeout: 10000 });
  await shot("m-20-waiting", false);
  await page.getByRole("heading", { name: "紹介が成立しました" }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  await shot("m-21-matched", false);
  await page.getByRole("link", { name: "連絡先を見る" }).click();
  await page.getByRole("heading", { name: "ご紹介" }).waitFor();
  await shot("m-22-introduction");
  await page.getByRole("button", { name: "商談になった" }).click();
  await page.getByRole("button", { name: "結果を記録する" }).click();
  await page.getByText("結果を記録しました").waitFor();
  ok(await page.getByText(/@.*example\.jp/).first().isVisible(), "紹介成立後に連絡先が表示される");
  await ctx.close();
}

/* ── 3. デモアカウントで各画面（スマホ・PC） ── */
for (const device of ["mobile", "desktop"]) {
  const p = device === "mobile" ? "m" : "d";
  const { ctx, page, shot } = await session(device);
  await page.goto(base + "/", { waitUntil: "load" });
  await page.waitForTimeout(1600);
  await shot(`${p}-30-lp`);
  await page.goto(base + "/login", { waitUntil: "load" });
  await shot(`${p}-31-login`);
  await page.getByRole("button", { name: "デモアカウントで見る" }).click();
  await page.waitForURL(/home/);
  await page.getByRole("heading", { name: "あなたへのおすすめ" }).waitFor();
  await page.waitForTimeout(800);
  await shot(`${p}-32-home`);
  await page.goto(base + "/matches", { waitUntil: "load" });
  await page.getByRole("tab", { name: /おすすめ/ }).waitFor();
  await page.waitForTimeout(600);
  await shot(`${p}-33-matches`);
  await page.getByRole("tab", { name: /あなたに興味/ }).click();
  await page.waitForTimeout(300);
  await shot(`${p}-34-matches-incoming`, false);
  // 興味を持たれている企業に回答 → その場で成立
  await page.locator('a[href^="/matches/"]').first().click();
  await page.getByRole("heading", { name: "相性が良い理由" }).waitFor();
  await shot(`${p}-35-match-incoming`);
  ok(!(await page.getByText(/@.*example\.jp/).count()), "承認前の詳細に連絡先が出ていない");
  await page.getByRole("button", { name: "話してみたい" }).first().click();
  await page.getByRole("heading", { name: "紹介が成立しました" }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(1400);
  await shot(`${p}-36-matched`, false);
  await page.getByRole("link", { name: "連絡先を見る" }).click();
  await page.getByRole("heading", { name: "ご紹介" }).waitFor();
  await shot(`${p}-37-introduction`);
  await page.goto(base + "/introductions", { waitUntil: "load" });
  await page.getByText("商談テーマ").first().waitFor();
  await shot(`${p}-38-introductions`);
  await page.goto(base + "/network", { waitUntil: "load" });
  await page.getByText(/^\d+ 社$/).waitFor();
  await shot(`${p}-39-network`);
  await page.getByLabel("企業を検索").fill("補助金");
  await page.waitForTimeout(900);
  await shot(`${p}-40-network-search`, false);
  await page.getByLabel("企業を検索").fill("該当なしの検索語");
  await page.waitForTimeout(900);
  await shot(`${p}-41-network-empty`, false);
  await page.getByLabel("企業を検索").fill("");
  if (device === "mobile") {
    await page.getByRole("button", { name: /絞り込み/ }).click();
    await page.waitForTimeout(400);
    await shot(`${p}-42-network-filter`, false);
    await page.keyboard.press("Escape");
  }
  await page.goto(base + "/network/c_keisho", { waitUntil: "load" });
  await page.getByRole("heading", { name: "求めていること" }).waitFor();
  await shot(`${p}-43-company`);
  ok(!(await page.getByText(/@.*example\.jp/).count()), "企業詳細に連絡先が出ていない");
  await page.goto(base + "/notifications", { waitUntil: "load" });
  await page.getByRole("heading", { name: "通知" }).waitFor();
  await page.waitForTimeout(600);
  await shot(`${p}-44-notifications`);
  await page.goto(base + "/profile", { waitUntil: "load" });
  await page.getByRole("heading", { name: "公開範囲" }).waitFor();
  await shot(`${p}-45-profile`);
  await page.goto(base + "/profile/edit", { waitUntil: "load" });
  await page.getByRole("heading", { name: "プロフィールを編集" }).waitFor();
  await page.waitForTimeout(600);
  await shot(`${p}-46-profile-edit`);
  // 運営画面
  await page.goto(base + "/login", { waitUntil: "load" });
  await page.getByRole("button", { name: "運営画面を見る" }).click();
  await page.waitForURL(/admin/);
  await page.getByRole("heading", { name: "紹介までの流れ" }).waitFor();
  await shot(`${p}-50-admin`);
  await page.goto(base + "/admin/matches", { waitUntil: "load" });
  await page.getByRole("button", { name: "手動で紹介する" }).waitFor();
  await page.waitForTimeout(700);
  await shot(`${p}-51-admin-matches`, false);
  await page.getByRole("button", { name: "手動で紹介する" }).click();
  await page.getByLabel("企業A").selectOption({ label: "株式会社ルミエ・ビューティー" });
  await page.getByLabel("企業B").selectOption({ label: "東雲建設工業株式会社" });
  await page.getByText(/から見た相性/).first().waitFor();
  await page.waitForTimeout(500);
  await shot(`${p}-52-admin-create`, false);
  await page.getByRole("button", { name: "紹介を作成して通知する" }).click();
  await page.getByText("紹介を作成しました").waitFor();
  await page.goto(base + "/admin/companies", { waitUntil: "load" });
  await page.getByText(/^\d+ 社$/).waitFor();
  await shot(`${p}-53-admin-companies`, false);
  await page.goto(base + "/admin/users", { waitUntil: "load" });
  await page.getByText(/^\d+ 名$/).waitFor();
  await page.getByRole("button", { name: "停止", exact: true }).first().click();
  await page.waitForTimeout(400);
  await shot(`${p}-54-admin-suspend`, false);
  await page.keyboard.press("Escape");
  await page.goto(base + "/admin/reports", { waitUntil: "load" });
  await page.getByText("未対応").first().waitFor();
  await shot(`${p}-55-admin-reports`, false);
  await ctx.close();
}

await browser.close();
console.log(`撮影 ${steps.length} 画面`);
if (problems.length) { console.log("問題:\n" + [...new Set(problems)].join("\n")); process.exit(1); }
console.log("問題なし");
