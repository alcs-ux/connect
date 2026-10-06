/**
 * Supabase プロジェクトにデモ用の企業データを投入する。
 *
 *   npx tsx scripts/seed-supabase.ts --yes-seed-demo-data      … 架空の26社を登録し、おすすめを生成する
 *   npx tsx scripts/seed-supabase.ts --make-admin you@example.jp … 既存ユーザーを運営（admin_users）にする
 *
 * 注意
 *  - 投入されるのは src/lib/data/seed-companies.ts の「架空の会社・人物」。本番のネットワークに混ぜないこと。
 *  - service_role キー（RLS を通らない）を使う。キーは .env.local か環境変数から読み、どこにも出力しない。
 *  - デモ企業の auth ユーザーには毎回ランダムなパスワードを設定し、表示も保存もしない（＝誰もログインできない）。
 *  - 何度実行しても同じ状態に収束する（既存のユーザー・企業は更新、既存のマッチは作り直さない）。
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { companyColumns, needColumns, offerColumns } from "../src/lib/data/mappers";
import { summarizeNeed, summarizeOffer } from "../src/lib/data/ops";
import { DEMO_COMPANY_KEY, SEED_COMPANIES, type SeedCompany } from "../src/lib/data/seed-companies";
import { generateForCompany, requestMatch } from "../src/lib/server/matching-service";
import type { FeedbackOutcome, NeedProfile, OfferProfile } from "../src/lib/types";

const FLAG = "--yes-seed-demo-data";
const DAY = 86400000;

/** .env.local → .env の順に読む最小限のパーサー。すでに設定済みの環境変数は上書きしない。 */
function loadEnvFiles() {
  for (const file of [".env.local", ".env"]) {
    const path = join(process.cwd(), file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      let value = m[2].trim();
      const quoted = /^(['"])(.*)\1$/.exec(value);
      if (quoted) value = quoted[2];
      else value = value.replace(/\s+#.*$/, "");
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  }
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** エラーの内容は表示するが、キーや本文は表示しない。 */
function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) fail(`${what}: ${res.error.message}`);
  return res.data as T;
}

function connect(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) fail("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を .env.local か環境変数に設定してください。");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/* ── --make-admin ─────────────────────────────── */

async function makeAdmin(db: SupabaseClient, email: string) {
  const find = async (value: string) =>
    must(await db.from("users").select("id, email").eq("email", value).maybeSingle<{ id: string; email: string }>(), "ユーザーの検索");
  const user = (await find(email)) ?? (await find(email.toLowerCase()));
  if (!user) fail(`${email} のユーザーが見つかりません。先にアプリで登録（またはログイン）してください。`);
  must(await db.from("admin_users").upsert({ user_id: user.id, role: "operator" }, { onConflict: "user_id", ignoreDuplicates: true }), "admin_users への追加");
  console.log(`✓ ${user.email} を運営（admin_users）に追加しました。`);
}

/* ── デモデータ ─────────────────────────────── */

const emailOf = (s: SeedCompany) => `${s.rep.mail}@${s.domain}`;
const daysAgo = (n: number, hour = 10) => {
  const d = new Date(Date.now() - n * DAY);
  if (n > 0) d.setHours(hour, (n * 17) % 60, 0, 0);
  return d.toISOString();
};

/** auth ユーザーを作る（すでにあれば public.users から引く）。public.users などの行はトリガーが用意する。 */
async function ensureUser(db: SupabaseClient, s: SeedCompany): Promise<string> {
  const email = emailOf(s);
  const existing = must(await db.from("users").select("id").eq("email", email).maybeSingle<{ id: string }>(), `${email} の確認`);
  if (existing) return existing.id;
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: randomBytes(32).toString("base64url"), // 表示も保存もしない
    email_confirm: true,
    user_metadata: { full_name: s.rep.name, demo: true },
  });
  if (error || !data.user) fail(`${email} の作成: ${error?.message ?? "ユーザーが返りませんでした"}`);
  return data.user.id;
}

async function seedCompany(db: SupabaseClient, s: SeedCompany): Promise<string> {
  const userId = await ensureUser(db, s);
  const joined = daysAgo(s.joinedDaysAgo, 19);

  const need: NeedProfile = {
    categories: s.need.cats, targetIndustries: s.need.industries ?? [], targetSizes: s.need.sizes ?? [], targetAreas: s.need.areas ?? [],
    targetRoles: s.need.roles ?? [], issues: s.need.issues, timing: s.need.timing, budget: s.need.budget ?? null, idealPartner: s.need.ideal, summary: "",
  };
  need.summary = summarizeNeed(need);
  const offer: OfferProfile = {
    categories: s.offer.cats, products: s.offer.products, idealCustomer: s.offer.idealCustomer, referableIndustries: s.offer.referable ?? [],
    partnership: s.offer.partnership, onlineOk: s.offer.online ?? true, referralLevel: s.offer.referral ?? "mid", summary: "",
  };
  offer.summary = summarizeOffer(offer);

  const cols = {
    ...companyColumns({
      name: s.name, entityType: s.entityType ?? "corporation", url: `https://${s.domain}`, industry: s.industry, tagline: s.tagline,
      description: s.description, prefecture: s.prefecture, city: s.city, employees: s.employees, foundedYear: s.founded, salesAreas: s.areas,
      targetCustomers: s.customers, services: s.services,
    }),
    owner_user_id: userId, status: "active", created_at: joined,
  };
  const company = must(await db.from("companies").upsert(cols, { onConflict: "owner_user_id" }).select("id").single<{ id: string }>(), `${s.name} の登録`);

  must(await db.from("company_private").upsert({ company_id: company.id, address: `${s.prefecture}${s.city}${s.street}`, revenue: s.revenue }, { onConflict: "company_id" }), "company_private");
  must(await db.from("needs").upsert(needColumns(company.id, need), { onConflict: "company_id" }), "needs");
  must(await db.from("offers").upsert(offerColumns(company.id, offer), { onConflict: "company_id" }), "offers");
  must(await db.from("user_profiles").update({
    company_id: company.id, name: s.rep.name, title: s.rep.title, role: s.rep.role, phone: s.rep.tel, is_decision_maker: s.rep.dm,
  }).eq("user_id", userId), "user_profiles");
  // seed.ts と同じ：決裁者は氏名を公開、それ以外は紹介成立後のみ
  must(await db.from("privacy_settings").upsert({ user_id: userId, person_name: s.rep.dm ? "public" : "after_match" }, { onConflict: "user_id" }), "privacy_settings");
  must(await db.from("consents").upsert(
    (["terms", "purpose", "matching", "contact_disclosure"] as const).map((kind) => ({ user_id: userId, kind, version: "2026-10", agreed_at: joined })),
    { onConflict: "user_id,kind,version", ignoreDuplicates: true },
  ), "consents");
  must(await db.from("users").update({ onboarded_at: joined, created_at: joined, last_active_at: daysAgo(s.activeDaysAgo, 9) }).eq("id", userId), "users");
  return company.id;
}

/** seed.ts（デモモード）と同じ「すでに動いているネットワーク」を、本番と同じ処理（requestMatch）で再現する。 */
async function seedHistory(db: SupabaseClient, id: (key: string) => string) {
  const one = (from: string, to: string) => requestMatch(db, id(from), id(to));
  const both = async (a: string, b: string) => {
    await one(a, b);
    const { matchId, introductionId } = await one(b, a);
    return { matchId, introductionId };
  };
  const feedback = async (intro: { matchId: string; introductionId: string | null }, from: string, about: string, outcome: FeedbackOutcome, note = "") => {
    if (!intro.introductionId) return;
    must(await db.from("match_feedback").upsert(
      { introduction_id: intro.introductionId, match_id: intro.matchId, from_company_id: id(from), about_company_id: id(about), outcome, note },
      { onConflict: "introduction_id,from_company_id", ignoreDuplicates: true },
    ), "match_feedback");
  };

  await feedback(await both("sowa-re", "shinonome"), "sowa-re", "shinonome", "deal", "店舗内装の案件を1件ご一緒しました。");
  await feedback(await both("minato-capital", "shirakaba"), "shirakaba", "minato-capital", "meeting");
  await both("keisho", "shirakaba");
  await feedback(await both("sumitoshun", "sowa-re"), "sumitoshun", "sowa-re", "useful");
  await feedback(await both("link-sales", "growth-data"), "growth-data", "link-sales", "contacted");
  await feedback(await both("hojokin-navi", "nortec"), "nortec", "hojokin-navi", "meeting");
  await both("telecom-line", "sowa-re");
  await both("tsumugi", "komorebi");
  await one("ecolux", "asanagi");
  await one("fukurie", "tsumugi");
  await one("kashiwagi", "lumie");

  const demo = DEMO_COMPANY_KEY;
  const aoba = await both(demo, "aoba-hr");
  await feedback(aoba, demo, "aoba-hr", "meeting");
  await feedback(aoba, "aoba-hr", demo, "meeting");
  await both(demo, "asanagi");
  await one("shinonome", demo);
  await one("komorebi", demo);
  await one("lumie", demo);
  await one(demo, "medical-step");
}

async function seedDemo(db: SupabaseClient) {
  console.log("────────────────────────────────────────────────────────────");
  console.log(" 注意：これから投入するのは「架空の会社・人物」のデモデータです。");
  console.log(` 接続先: ${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").host}`);
  console.log(" 実際の利用者がいるプロジェクトでは実行しないでください。");
  console.log("────────────────────────────────────────────────────────────");

  const ids = new Map<string, string>();
  for (const s of SEED_COMPANIES) {
    ids.set(s.key, await seedCompany(db, s));
    console.log(`✓ ${s.name}`);
  }
  const id = (key: string) => {
    const v = ids.get(key);
    if (!v) fail(`seed-companies.ts に ${key} がありません`);
    return v;
  };

  console.log("\n紹介の履歴を作成しています…");
  await seedHistory(db, id);

  console.log("おすすめを生成しています…");
  let total = 0;
  for (const s of SEED_COMPANIES) {
    const created = await generateForCompany(db, id(s.key), 5);
    total += created.length;
  }
  console.log(`\n✓ 完了：${SEED_COMPANIES.length}社を登録し、おすすめを${total}件生成しました。`);
  console.log("  運営アカウントは、アプリで登録したあと --make-admin <メールアドレス> で追加できます。");
}

async function main() {
  loadEnvFiles();
  const args = process.argv.slice(2);
  const adminAt = args.indexOf("--make-admin");
  const wantsSeed = args.includes(FLAG);

  if (adminAt === -1 && !wantsSeed) {
    console.error("このスクリプトは、架空のデモデータ（26社）を Supabase に投入します。");
    console.error(`実行するには ${FLAG} を付けてください：`);
    console.error(`  npx tsx scripts/seed-supabase.ts ${FLAG}`);
    console.error("既存ユーザーを運営にするだけなら：");
    console.error("  npx tsx scripts/seed-supabase.ts --make-admin <メールアドレス>");
    process.exit(1);
  }
  const adminEmail = adminAt === -1 ? null : args[adminAt + 1];
  if (adminAt !== -1 && (!adminEmail || adminEmail.startsWith("--"))) fail("--make-admin の後にメールアドレスを指定してください。");

  const db = connect();
  if (wantsSeed) await seedDemo(db);
  if (adminEmail) await makeAdmin(db, adminEmail.trim());
}

main().catch((e) => {
  console.error("✗ 失敗しました:", e instanceof Error ? e.message : e);
  process.exit(1);
});
