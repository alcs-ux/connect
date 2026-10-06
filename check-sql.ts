/**
 * マイグレーションと公開範囲（RLS）の検証： npm run test:sql
 *
 * PGlite（インメモリのPostgreSQL）に supabase/migrations をそのまま流し、
 * 「他社の連絡先が読めない」「マッチングの書き込みがクライアントからできない」などを
 * 実際のSQLで確かめる。1件でも失敗したら終了コード1。
 *
 * PGlite と Supabase の違いを埋めるための細工（＝本番と違う点）はここだけ：
 *   [W1] auth / storage スキーマが無いので、最小限のスタブを先に作る。
 *        auth.uid() は Supabase と同じく request.jwt.claim.sub を読む。
 *   [W2] anon / authenticated / service_role ロールと、Supabase が public スキーマに
 *        標準で付けている権限（default privileges）を先に用意する。
 *        これが無いと「RLSで弾かれた」のか「GRANTが無いだけ」なのか区別できない。
 *   [W3] pgcrypto は PGlite では拡張を明示的に読み込む必要がある（extensions オプション）。
 *   [W4] PostgREST の代わりに、トランザクション内で set local role と set_config を使って
 *        「そのユーザーとして」実行する。検証後は必ず rollback する。
 * マイグレーションSQL自体は一切書き換えずに実行している。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const MIGRATIONS = ["0001_schema.sql", "0002_rls.sql"];

const STUBS = `
  -- [W2] ロール
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$;

  -- [W1] auth
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;

  -- [W1] storage
  create schema if not exists storage;
  create table storage.buckets (id text primary key, name text, public boolean);
  create table storage.objects (id uuid default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
    select string_to_array(name, '/')
  $$;
  grant usage on schema storage to anon, authenticated, service_role;
  grant all on storage.objects to authenticated, service_role;

  -- [W2] Supabase が public に標準で付けている権限
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

/* ── テストデータ（すべて架空） ─────────────────────────────── */
const U = { A: "00000000-0000-4000-8000-00000000000a", B: "00000000-0000-4000-8000-00000000000b", C: "00000000-0000-4000-8000-00000000000c" };
// matches / connections は company_a < company_b が必須なので、A < B < C になるIDにしてある
const CO = { A: "10000000-0000-4000-8000-00000000000a", B: "20000000-0000-4000-8000-00000000000b", C: "30000000-0000-4000-8000-00000000000c" };
const MATCH_AB = "aaaaaaaa-0000-4000-8000-0000000000ab";
const INTRO_AB = "bbbbbbbb-0000-4000-8000-0000000000ab";

const FIXTURES = `
  insert into auth.users (id, email, raw_user_meta_data) values
    ('${U.A}', 'a-owner@a.example.jp', '{"full_name":"青木 一郎"}'),
    ('${U.B}', 'b-owner@b.example.jp', '{"name":"馬場 二郎"}'),
    ('${U.C}', 'c-owner@c.example.jp', '{}');

  insert into public.companies (id, owner_user_id, name, industry, prefecture, city) values
    ('${CO.A}', '${U.A}', 'A社', 'web', '東京都', '渋谷区'),
    ('${CO.B}', '${U.B}', 'B社', 'hr', '東京都', '港区'),
    ('${CO.C}', '${U.C}', 'C社', 'construction', '大阪府', '大阪市');
  insert into public.company_private (company_id, address, revenue) values
    ('${CO.A}', '東京都渋谷区神南1-1-1', 'r2'), ('${CO.B}', '東京都港区芝2-2-2', 'r3'), ('${CO.C}', '大阪府大阪市北区3-3-3', 'r1');
  insert into public.needs (company_id, categories, ideal_partner) values
    ('${CO.A}', '{new_customers,alliance}', 'A社の理想の相手'), ('${CO.B}', '{hiring}', ''), ('${CO.C}', '{system}', '');
  insert into public.offers (company_id, categories, products) values
    ('${CO.A}', '{web_production,recruit_support}', 'A社の商品'), ('${CO.B}', '{recruit_support}', ''), ('${CO.C}', '{construction}', '');

  update public.user_profiles set company_id = '${CO.A}', name = '青木 一郎', title = '代表取締役', role = 'ceo', phone = '03-0000-0001', is_decision_maker = true where user_id = '${U.A}';
  update public.user_profiles set company_id = '${CO.B}', name = '馬場 二郎', title = '営業部長', role = 'sales_head', phone = '03-0000-0002' where user_id = '${U.B}';
  update public.user_profiles set company_id = '${CO.C}', name = '千葉 三郎', title = '代表', role = 'ceo', phone = '06-0000-0003' where user_id = '${U.C}';

  -- A：氏名は紹介成立後のみ（既定）、電話は非公開
  update public.privacy_settings set person_name = 'after_match', phone = 'hidden' where user_id = '${U.A}';

  -- A–B だけが紹介成立済み
  insert into public.matches (id, company_a, company_b, status) values ('${MATCH_AB}', '${CO.A}', '${CO.B}', 'mutual');
  insert into public.match_scores (match_id, viewer_company_id, total, breakdown) values
    ('${MATCH_AB}', '${CO.A}', 81, '{}'), ('${MATCH_AB}', '${CO.B}', 74, '{}');
  insert into public.introductions (id, match_id, company_a, company_b, theme, body) values
    ('${INTRO_AB}', '${MATCH_AB}', '${CO.A}', '${CO.B}', 'テーマ', '紹介文');
  insert into public.connections (company_a, company_b, introduction_id) values ('${CO.A}', '${CO.B}', '${INTRO_AB}');
  insert into public.notifications (user_id, kind, title) values ('${U.A}', 'introduction', 'B社との紹介が成立しました');
`;

/* ── 実行ヘルパー ─────────────────────────────── */
type Row = Record<string, unknown>;
type Actor = { role: "authenticated" | "anon"; sub: string | null };
const as = (sub: string): Actor => ({ role: "authenticated", sub });
const ANON: Actor = { role: "anon", sub: null };

let db: PGlite;
let failed = 0;
let passed = 0;

function report(ok: boolean, label: string, detail = "") {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "✓" : "✗"} ${label}${!ok && detail ? `\n    → ${detail}` : ""}`);
}

/** [W4] 指定したユーザーとしてSQLを実行し、必ず rollback する。エラーは文字列で返す。 */
async function run(actor: Actor, sql: string, setup?: string): Promise<{ rows: Row[]; affected: number; error: string | null }> {
  await db.exec("begin");
  try {
    if (setup) await db.exec(setup); // スーパーユーザーとしての前準備（このトランザクション限り）
    await db.exec(`set local role ${actor.role}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [actor.sub ?? ""]);
    const res = await db.query<Row>(sql);
    return { rows: res.rows, affected: res.affectedRows ?? 0, error: null };
  } catch (e) {
    return { rows: [], affected: 0, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await db.exec("rollback");
  }
}

async function expectRows(label: string, actor: Actor, sql: string, n: number, setup?: string): Promise<Row[]> {
  const r = await run(actor, sql, setup);
  report(!r.error && r.rows.length === n, label, r.error ?? `${n}行のはずが${r.rows.length}行: ${JSON.stringify(r.rows).slice(0, 300)}`);
  return r.rows;
}

/** 0行、または権限エラーであること（どちらでも「読めない」） */
async function expectHidden(label: string, actor: Actor, sql: string) {
  const r = await run(actor, sql);
  const denied = !!r.error && /permission denied|row-level security/i.test(r.error);
  report(denied || (!r.error && r.rows.length === 0), label, r.error ?? `${r.rows.length}行見えている: ${JSON.stringify(r.rows).slice(0, 300)}`);
}

/** 権限エラーまたはRLS違反で失敗すること */
async function expectDenied(label: string, actor: Actor, sql: string, setup?: string) {
  const r = await run(actor, sql, setup);
  const denied = !!r.error && /permission denied|row-level security/i.test(r.error);
  report(denied, label, r.error ? `想定外のエラー: ${r.error}` : "エラーにならず実行できてしまった");
}

/** エラーにはならないが、1行も変更できないこと（RLSの using で対象外になる） */
async function expectNoEffect(label: string, actor: Actor, sql: string) {
  const r = await run(actor, sql);
  const denied = !!r.error && /permission denied|row-level security/i.test(r.error);
  report(denied || (!r.error && r.affected === 0), label, r.error ?? `${r.affected}行が変更された`);
}

async function expectOk(label: string, actor: Actor, sql: string, minAffected = 1, setup?: string) {
  const r = await run(actor, sql, setup);
  report(!r.error && r.affected >= minAffected, label, r.error ?? `変更行数 ${r.affected}`);
}

function check(label: string, cond: boolean, detail = "") {
  report(cond, label, detail);
}

/** 失敗扱いにしない注意事項（SQLの改善提案など） */
function note(label: string) {
  console.log(`! ${label}`);
}

async function scalar<T>(sql: string): Promise<T> {
  const r = await db.query<{ v: T }>(sql);
  return r.rows[0].v;
}

/* ── 本体 ─────────────────────────────── */
async function applyMigrations(): Promise<boolean> {
  for (const file of MIGRATIONS) {
    const sql = readFileSync(join(process.cwd(), "supabase", "migrations", file), "utf8");
    try {
      await db.exec(sql);
      report(true, `マイグレーション ${file} を適用できる`);
    } catch (e) {
      report(false, `マイグレーション ${file} を適用できる`, e instanceof Error ? e.message : String(e));
      return false;
    }
  }
  return true;
}

async function main() {
  db = new PGlite({ extensions: { pgcrypto } }); // [W3]
  await db.exec(STUBS);

  console.log("── マイグレーション ──");
  if (!(await applyMigrations())) return;

  try {
    await db.exec(FIXTURES);
    report(true, "テストデータを投入できる（制約・トリガーが通る）");
  } catch (e) {
    report(false, "テストデータを投入できる（制約・トリガーが通る）", e instanceof Error ? e.message : String(e));
    return;
  }

  console.log("\n── トリガー ──");
  check("auth.users への追加で users が作られる", (await scalar<number>("select count(*)::int as v from public.users")) === 3);
  check("auth.users への追加で user_profiles が作られる", (await scalar<number>("select count(*)::int as v from public.user_profiles")) === 3);
  check("auth.users への追加で privacy_settings が作られる", (await scalar<number>("select count(*)::int as v from public.privacy_settings")) === 3);
  check("users.email に auth.users のメールが入る", (await scalar<string>(`select email as v from public.users where id = '${U.A}'`)) === "a-owner@a.example.jp");
  const cats = await db.query<{ kind: string; category: string; position: number }>(
    `select kind, category, position from public.company_categories where company_id = '${CO.A}' order by kind, position`,
  );
  const catKey = cats.rows.map((r) => `${r.kind}:${r.category}:${r.position}`).join(",");
  check(
    "company_categories が業種・ニーズ・提供物のトリガーで作られる（順序つき）",
    catKey === "industry:web:1,need:new_customers:1,need:alliance:2,offer:web_production:1,offer:recruit_support:2",
    catKey,
  );
  await db.exec(`update public.needs set categories = '{hiring}' where company_id = '${CO.C}'`);
  check(
    "needs.categories を更新すると company_categories も置き換わる",
    (await scalar<string>(`select string_agg(category, ',') as v from public.company_categories where company_id = '${CO.C}' and kind = 'need'`)) === "hiring",
  );
  const touched = await scalar<boolean>(`
    with before as (select updated_at as t from public.companies where id = '${CO.C}'),
         upd as (update public.companies set tagline = 'x' where id = '${CO.C}' returning updated_at as t)
    select (select t from upd) >= (select t from before) as v`);
  check("companies の更新で updated_at が更新される", touched === true);

  console.log("\n── 本人は自分の行を読める（以降の「0行」が空振りでないことの確認） ──");
  await expectRows("A は自分の user_profiles を読める", as(U.A), `select * from public.user_profiles where user_id = '${U.A}'`, 1);
  await expectRows("A は自分の users を読める", as(U.A), `select * from public.users where id = '${U.A}'`, 1);
  await expectRows("A は自社の company_private を読める", as(U.A), `select * from public.company_private where company_id = '${CO.A}'`, 1);
  await expectRows("A は自社の needs を読める", as(U.A), `select * from public.needs where company_id = '${CO.A}'`, 1);

  console.log("\n── 他社のベーステーブルは読めない ──");
  await expectHidden("C は A の user_profiles を読めない", as(U.C), `select * from public.user_profiles where user_id = '${U.A}'`);
  await expectHidden("C は A の users（メール）を読めない", as(U.C), `select * from public.users where id = '${U.A}'`);
  await expectHidden("C は A の company_private（番地・売上）を読めない", as(U.C), `select * from public.company_private where company_id = '${CO.A}'`);
  await expectHidden("C は A の needs を直接は読めない", as(U.C), `select * from public.needs where company_id = '${CO.A}'`);
  await expectHidden("C は A の offers を直接は読めない", as(U.C), `select * from public.offers where company_id = '${CO.A}'`);
  await expectHidden("C は A の companies を直接は読めない", as(U.C), `select * from public.companies where id = '${CO.A}'`);
  await expectHidden("C は A の privacy_settings を読めない", as(U.C), `select * from public.privacy_settings where user_id = '${U.A}'`);
  await expectHidden("C は A の通知を読めない", as(U.C), `select * from public.notifications where user_id = '${U.A}'`);
  await expectHidden("紹介成立済みの B でも A の user_profiles は直接読めない", as(U.B), `select * from public.user_profiles where user_id = '${U.A}'`);
  await expectHidden("紹介成立済みの B でも A の users は直接読めない", as(U.B), `select * from public.users where id = '${U.A}'`);

  console.log("\n── company_directory（公開用ビュー） ──");
  const cols = await db.query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'company_directory'",
  );
  const colNames = cols.rows.map((r) => r.column_name);
  const leaky = colNames.filter((c) => /mail|phone|tel|address|owner/i.test(c));
  check("ビューにメール・電話・番地・owner の列が存在しない", leaky.length === 0, leaky.join(","));
  const dirC = await expectRows("C は company_directory で A を見られる", as(U.C), `select * from public.company_directory where id = '${CO.A}'`, 1);
  check("C には A の代表者名が NULL（person_name = after_match）", dirC[0]?.representative_name === null, String(dirC[0]?.representative_name));
  check("C には A の役職は見える（title = public）", dirC[0]?.representative_title === "代表取締役", String(dirC[0]?.representative_title));
  check("C には A の売上規模が見える（revenue = public）", dirC[0]?.revenue === "r2", String(dirC[0]?.revenue));
  const needJson = dirC[0]?.need as { categories?: string[]; company_id?: string } | undefined;
  check("ビューの need は構造化データで、company_id を含まない", Array.isArray(needJson?.categories) && needJson?.company_id === undefined, JSON.stringify(needJson));
  const dirB = await expectRows("B は company_directory で A を見られる", as(U.B), `select * from public.company_directory where id = '${CO.A}'`, 1);
  check("紹介成立済みの B には A の代表者名が見える", dirB[0]?.representative_name === "青木 一郎", String(dirB[0]?.representative_name));
  const dirSelf = await expectRows("A は自社を company_directory で見られる", as(U.A), `select * from public.company_directory where id = '${CO.A}'`, 1);
  check("A 自身には自分の代表者名が見える", dirSelf[0]?.representative_name === "青木 一郎", String(dirSelf[0]?.representative_name));
  const hiddenRevenue = await run(as(U.C), `select revenue, representative_title from public.company_directory where id = '${CO.A}'`,
    `update public.privacy_settings set revenue = 'hidden', title = 'after_match' where user_id = '${U.A}'`);
  check("revenue = hidden なら C に売上規模は NULL", !hiddenRevenue.error && hiddenRevenue.rows[0]?.revenue === null, hiddenRevenue.error ?? JSON.stringify(hiddenRevenue.rows));
  check("title = after_match なら C に役職は NULL", !hiddenRevenue.error && hiddenRevenue.rows[0]?.representative_title === null, hiddenRevenue.error ?? JSON.stringify(hiddenRevenue.rows));
  const publicName = await run(as(U.C), `select representative_name from public.company_directory where id = '${CO.A}'`,
    `update public.privacy_settings set person_name = 'public' where user_id = '${U.A}'`);
  check("person_name = public なら C にも代表者名が見える", publicName.rows[0]?.representative_name === "青木 一郎", publicName.error ?? JSON.stringify(publicName.rows));
  const suspended = await run(as(U.C), `select id from public.company_directory where id = '${CO.A}'`,
    `update public.companies set status = 'suspended' where id = '${CO.A}'`);
  check("停止中の企業は他社の company_directory に出ない", !suspended.error && suspended.rows.length === 0, suspended.error ?? JSON.stringify(suspended.rows));
  await expectHidden("anon（未ログイン）は company_directory を読めない", ANON, "select * from public.company_directory");
  await expectHidden("anon は companies を読めない", ANON, "select * from public.companies");
  await expectHidden("anon は user_profiles を読めない", ANON, "select * from public.user_profiles");

  console.log("\n── get_contact（連絡先の開示） ──");
  await expectRows("C（紹介なし）には A の連絡先が返らない", as(U.C), `select * from public.get_contact('${CO.A}')`, 0);
  const contactB = await expectRows("B（紹介成立済み）には A の連絡先が1行返る", as(U.B), `select * from public.get_contact('${CO.A}')`, 1);
  check("B にはメールアドレスが開示される", contactB[0]?.email === "a-owner@a.example.jp", String(contactB[0]?.email));
  check("A の電話は phone = hidden なので B にも NULL", contactB[0]?.phone === null, String(contactB[0]?.phone));
  const contactA = await expectRows("A には B の連絡先が1行返る", as(U.A), `select * from public.get_contact('${CO.B}')`, 1);
  check("B の電話は既定（after_match）なので A に開示される", contactA[0]?.phone === "03-0000-0002", String(contactA[0]?.phone));
  const contactSelf = await expectRows("A は自社の連絡先を取得できる", as(U.A), `select * from public.get_contact('${CO.A}')`, 1);
  check("本人には非公開設定の電話も返る", contactSelf[0]?.phone === "03-0000-0001", String(contactSelf[0]?.phone));
  await expectDenied("anon は get_contact を実行できない", ANON, `select * from public.get_contact('${CO.A}')`);

  console.log("\n── マッチ・紹介・つながり（当事者のみ） ──");
  await expectRows("A は A–B のマッチを読める", as(U.A), `select * from public.matches where id = '${MATCH_AB}'`, 1);
  await expectHidden("C は A–B のマッチを読めない", as(U.C), "select * from public.matches");
  await expectHidden("C は A–B の紹介を読めない", as(U.C), "select * from public.introductions");
  await expectHidden("C は A–B のつながりを読めない", as(U.C), "select * from public.connections");
  await expectHidden("C は A–B のスコアを読めない", as(U.C), "select * from public.match_scores");
  await expectRows("B は自分が見る側のスコアを読める", as(U.B), `select * from public.match_scores where viewer_company_id = '${CO.B}'`, 1);
  await expectHidden("B は A から見たスコア（viewer = A）を読めない", as(U.B), `select * from public.match_scores where viewer_company_id = '${CO.A}'`);

  const reqSetup = (decision: string) =>
    `insert into public.match_requests (match_id, from_company_id, to_company_id, decision) values ('${MATCH_AB}', '${CO.A}', '${CO.B}', '${decision}')`;
  const passed_ = await run(as(U.B), "select * from public.match_requests", reqSetup("passed"));
  check("A の「見送り」は B に見えない", !passed_.error && passed_.rows.length === 0, passed_.error ?? JSON.stringify(passed_.rows));
  const interested = await run(as(U.B), "select * from public.match_requests", reqSetup("interested"));
  check("A の「話してみたい」は B に見える", !interested.error && interested.rows.length === 1, interested.error ?? JSON.stringify(interested.rows));
  const ownPassed = await run(as(U.A), "select * from public.match_requests", reqSetup("passed"));
  check("A は自分の「見送り」を読める", !ownPassed.error && ownPassed.rows.length === 1, ownPassed.error ?? JSON.stringify(ownPassed.rows));
  const thirdParty = await run(as(U.C), "select * from public.match_requests", reqSetup("interested"));
  check("C は A→B の回答を読めない", !thirdParty.error && thirdParty.rows.length === 0, thirdParty.error ?? JSON.stringify(thirdParty.rows));

  console.log("\n── マッチングの書き込みはクライアントからできない ──");
  await expectDenied("C は matches に INSERT できない", as(U.C), `insert into public.matches (company_a, company_b) values ('${CO.A}', '${CO.C}')`);
  await expectDenied("C は match_requests に INSERT できない", as(U.C),
    `insert into public.match_requests (match_id, from_company_id, to_company_id, decision) values ('${MATCH_AB}', '${CO.C}', '${CO.A}', 'interested')`);
  await expectDenied("B（当事者）でも match_requests に直接 INSERT できない", as(U.B),
    `insert into public.match_requests (match_id, from_company_id, to_company_id, decision) values ('${MATCH_AB}', '${CO.B}', '${CO.A}', 'interested')`);
  await expectDenied("C は introductions に INSERT できない（＝連絡先の開示条件を自作できない）", as(U.C),
    `insert into public.introductions (match_id, company_a, company_b) values ('${MATCH_AB}', '${CO.A}', '${CO.C}')`);
  await expectDenied("C は connections に INSERT できない", as(U.C), `insert into public.connections (company_a, company_b) values ('${CO.A}', '${CO.C}')`);
  await expectDenied("C は match_scores に INSERT できない", as(U.C),
    `insert into public.match_scores (match_id, viewer_company_id, total, breakdown) values ('${MATCH_AB}', '${CO.C}', 99, '{}')`);
  await expectDenied("C は notifications に INSERT できない（他人宛て）", as(U.C), `insert into public.notifications (user_id, kind, title) values ('${U.A}', 'system', 'x')`);
  await expectDenied("C は notifications に INSERT できない（自分宛て）", as(U.C), `insert into public.notifications (user_id, kind, title) values ('${U.C}', 'system', 'x')`);
  await expectNoEffect("A は matches.status を書き換えられない", as(U.A), `update public.matches set status = 'closed' where id = '${MATCH_AB}'`);
  await expectNoEffect("B は自分のスコアを書き換えられない", as(U.B), `update public.match_scores set total = 100 where match_id = '${MATCH_AB}'`);
  await expectNoEffect("A は紹介を削除できない", as(U.A), `delete from public.introductions where id = '${INTRO_AB}'`);
  await expectDenied("C は admin_users に自分を追加できない", as(U.C), `insert into public.admin_users (user_id) values ('${U.C}')`);
  await expectDenied("C は A–B の紹介にフィードバックを書けない", as(U.C),
    `insert into public.match_feedback (introduction_id, match_id, from_company_id, about_company_id, outcome) values ('${INTRO_AB}', '${MATCH_AB}', '${CO.C}', '${CO.A}', 'not_fit')`);
  await expectOk("B は A–B の紹介にフィードバックを書ける", as(U.B),
    `insert into public.match_feedback (introduction_id, match_id, from_company_id, about_company_id, outcome) values ('${INTRO_AB}', '${MATCH_AB}', '${CO.B}', '${CO.A}', 'meeting')`);
  await expectDenied("B は紹介と無関係な C についてのフィードバックを INSERT できない", as(U.B),
    `insert into public.match_feedback (introduction_id, match_id, from_company_id, about_company_id, outcome) values ('${INTRO_AB}', '${MATCH_AB}', '${CO.B}', '${CO.C}', 'not_fit')`);

  console.log("\n── 自分の行でも変更できない列（停止の解除など） ──");
  await expectDenied("C は自社の companies.status を変更できない", as(U.C), `update public.companies set status = 'active' where id = '${CO.C}'`);
  await expectDenied("C は自分の users.status を変更できない", as(U.C), `update public.users set status = 'active' where id = '${U.C}'`);
  await expectDenied("C は自分の users.email を変更できない", as(U.C), `update public.users set email = 'x@example.jp' where id = '${U.C}'`);
  await expectDenied("C は companies.owner_user_id を付け替えられない", as(U.C), `update public.companies set owner_user_id = '${U.A}' where id = '${CO.C}'`);
  await expectOk("C は自社の companies.name は変更できる", as(U.C), `update public.companies set name = 'C社（改）' where id = '${CO.C}'`);
  await expectOk("C は自分の users.last_active_at は更新できる", as(U.C), `update public.users set last_active_at = now() where id = '${U.C}'`);
  await expectNoEffect("C は A社の companies.name を変更できない", as(U.C), `update public.companies set name = '乗っ取り' where id = '${CO.A}'`);
  await expectNoEffect("C は A の user_profiles を変更できない", as(U.C), `update public.user_profiles set phone = '000' where user_id = '${U.A}'`);
  await expectNoEffect("C は A の privacy_settings を変更できない", as(U.C), `update public.privacy_settings set person_name = 'public' where user_id = '${U.A}'`);
  await expectDenied("自分宛ての通知でも本文は書き換えられない（read_at 以外は列権限なし）", as(U.C), `update public.notifications set title = 'x' where user_id = '${U.C}'`);
  await expectOk("A は自分の通知を既読にできる", as(U.A), `update public.notifications set read_at = now() where user_id = '${U.A}'`);

  console.log("\n── connection_degrees（つながりの距離） ──");
  await expectRows("C はつながりが無いので何も返らない", as(U.C), "select * from public.connection_degrees()", 0);
  const addBC = `insert into public.connections (company_a, company_b) values ('${CO.B}', '${CO.C}')`;
  const deg = await run(as(U.C), "select company_id, degree, via_company_id from public.connection_degrees() order by degree", addBC);
  const degKey = deg.rows.map((r) => `${r.company_id}:${r.degree}:${r.via_company_id}`).join(" | ");
  check("B–C を追加すると、C から B が1次", deg.rows.some((r) => r.company_id === CO.B && r.degree === 1 && r.via_company_id === null), deg.error ?? degKey);
  check("C から A が2次（経由 = B）", deg.rows.some((r) => r.company_id === CO.A && r.degree === 2 && r.via_company_id === CO.B), deg.error ?? degKey);
  check("自社は結果に含まれない", !deg.error && !deg.rows.some((r) => r.company_id === CO.C), deg.error ?? degKey);
  const stillHidden = await run(as(U.C), `select * from public.connections where company_a = '${CO.A}' and company_b = '${CO.B}'`, addBC);
  check("2次でつながっても、A–B の辺そのものは C に見えない", !stillHidden.error && stillHidden.rows.length === 0, stillHidden.error ?? "");
  const contact2nd = await run(as(U.C), `select * from public.get_contact('${CO.A}')`, addBC);
  check("2次のつながりだけでは A の連絡先は開示されない", !contact2nd.error && contact2nd.rows.length === 0, contact2nd.error ?? JSON.stringify(contact2nd.rows));
  await expectDenied("anon は connection_degrees を実行できない", ANON, "select * from public.connection_degrees()");

  console.log("\n── 通報・ログ・同意 ──");
  await expectOk("C は A社を通報できる", as(U.C), `insert into public.reports (reporter_user_id, target_company_id, reason) values ('${U.C}', '${CO.A}', 'spam')`);
  await expectDenied("C は他人名義では通報できない", as(U.C), `insert into public.reports (reporter_user_id, target_company_id, reason) values ('${U.B}', '${CO.A}', 'spam')`);
  await expectOk("C は自分の行動ログを書ける", as(U.C), `insert into public.activities (user_id, type) values ('${U.C}', 'login')`);
  await expectHidden("C は行動ログを読めない（運営のみ）", as(U.C), "select * from public.activities");
  await expectOk("C は自分の同意を記録できる", as(U.C), `insert into public.consents (user_id, kind, version) values ('${U.C}', 'terms', '2026-10')`);
  await expectDenied("C は A の同意を記録できない", as(U.C), `insert into public.consents (user_id, kind, version) values ('${U.A}', 'terms', '2026-10')`);
  await expectDenied("停止中のユーザーは企業を新規登録できない", as(U.C),
    `insert into public.companies (owner_user_id, name) values ('${U.C}', '再登録')`,
    `update public.users set status = 'suspended' where id = '${U.C}'; delete from public.companies where id = '${CO.C}'`);
  const reinsert = await run(as(U.C), `insert into public.companies (owner_user_id, name) values ('${U.C}', '再登録')`, `delete from public.companies where id = '${CO.C}'`);
  check("（対照）停止されていなければ企業を登録できる", !reinsert.error && reinsert.affected === 1, reinsert.error ?? "");

  console.log("\n── クライアント（supabase.ts）が行う書き込みは RLS を通る ──");
  // PostgREST の upsert は「INSERT … ON CONFLICT (…) DO UPDATE SET 全列 = EXCLUDED.全列」になるので、その形で確かめる
  const U_D = "00000000-0000-4000-8000-00000000000d";
  const CO_D = "40000000-0000-4000-8000-00000000000d";
  const newUser = `insert into auth.users (id, email) values ('${U_D}', 'd-owner@d.example.jp')`;
  const withCompany = `${newUser}; insert into public.companies (id, owner_user_id, name) values ('${CO_D}', '${U_D}', 'D社')`;
  const onboard = await run(as(U_D), `insert into public.companies (owner_user_id, name, industry, sales_areas, services) values ('${U_D}', 'D社', 'web', '{tokyo}', '{制作}') returning id`, newUser);
  check("新規ユーザーは自社を登録でき、作成した行を受け取れる（insert … returning）", !onboard.error && onboard.rows.length === 1, onboard.error ?? "");
  await expectOk("登録済みの自社を更新して所在地を受け取れる（update … returning）", as(U_D),
    `update public.companies set name = 'D社', prefecture = '東京都', city = '港区' where id = '${CO_D}' returning prefecture, city`, 1, withCompany);
  await expectOk("company_private を upsert できる", as(U_D),
    `insert into public.company_private (company_id, address, revenue) values ('${CO_D}', '東京都港区', 'r1')
       on conflict (company_id) do update set company_id = excluded.company_id, address = excluded.address, revenue = excluded.revenue`, 1, withCompany);
  await expectOk("needs を upsert できる（新規）", as(U_D),
    `insert into public.needs (company_id, categories, timing, summary) values ('${CO_D}', '{hiring}', '1m', 's')
       on conflict (company_id) do update set company_id = excluded.company_id, categories = excluded.categories, timing = excluded.timing, summary = excluded.summary`, 1, withCompany);
  await expectOk("needs を upsert できる（既存行の更新）", as(U.A),
    `insert into public.needs (company_id, categories, timing, summary) values ('${CO.A}', '{hiring}', '1m', 's')
       on conflict (company_id) do update set company_id = excluded.company_id, categories = excluded.categories, timing = excluded.timing, summary = excluded.summary`);
  await expectOk("offers を upsert できる", as(U_D),
    `insert into public.offers (company_id, categories, products) values ('${CO_D}', '{web_production}', 'p')
       on conflict (company_id) do update set company_id = excluded.company_id, categories = excluded.categories, products = excluded.products`, 1, withCompany);
  await expectDenied("他社の needs は upsert で上書きできない", as(U_D),
    `insert into public.needs (company_id, categories) values ('${CO.A}', '{hiring}')
       on conflict (company_id) do update set categories = excluded.categories`, withCompany);
  await expectOk("user_profiles を更新できる（company_id を含む）", as(U_D),
    `update public.user_profiles set name = '出口 四郎', title = '代表', role = 'ceo', phone = '03-0000-0004', is_decision_maker = true, company_id = '${CO_D}' where user_id = '${U_D}'`, 1, withCompany);
  const privacyNoop = await run(as(U_D), `insert into public.privacy_settings (user_id) values ('${U_D}') on conflict (user_id) do nothing`, newUser);
  check("privacy_settings の「無ければ作る」がエラーにならない", !privacyNoop.error, privacyNoop.error ?? "");
  await expectOk("privacy_settings を upsert で変更できる", as(U_D),
    `insert into public.privacy_settings (user_id, person_name) values ('${U_D}', 'public')
       on conflict (user_id) do update set user_id = excluded.user_id, person_name = excluded.person_name`, 1, newUser);
  await expectOk("同意4件を記録できる（重複は無視）", as(U_D),
    `insert into public.consents (user_id, kind, version) values ('${U_D}', 'terms', '2026-10'), ('${U_D}', 'purpose', '2026-10'), ('${U_D}', 'matching', '2026-10'), ('${U_D}', 'contact_disclosure', '2026-10')
       on conflict (user_id, kind, version) do nothing`, 4, newUser);
  await expectOk("users.onboarded_at を更新できる", as(U_D), `update public.users set onboarded_at = now(), last_active_at = now() where id = '${U_D}'`, 1, newUser);
  await expectOk("名刺を登録できる", as(U_D), `insert into public.business_cards (user_id, storage_path, extracted, confirmed_at) values ('${U_D}', '${U_D}/x.jpg', '{}', now())`, 1, newUser);
  await expectOk("名刺画像を自分のフォルダに置ける（Storage）", as(U_D), `insert into storage.objects (bucket_id, name) values ('business-cards', '${U_D}/x.jpg')`, 1, newUser);
  await expectDenied("名刺画像を他人のフォルダには置けない（Storage）", as(U_D), `insert into storage.objects (bucket_id, name) values ('business-cards', '${U.A}/x.jpg')`, newUser);
  const feedbackSetup = `insert into public.match_feedback (introduction_id, match_id, from_company_id, about_company_id, outcome) values ('${INTRO_AB}', '${MATCH_AB}', '${CO.B}', '${CO.A}', 'contacted')`;
  await expectOk("自分のフィードバックの outcome / note を更新できる", as(U.B),
    `update public.match_feedback set outcome = 'deal', note = 'n' where introduction_id = '${INTRO_AB}' and from_company_id = '${CO.B}' returning id`, 1, feedbackSetup);
  await expectOk("自分の行動ログ（企業ID・meta つき）を書ける", as(U.A), `insert into public.activities (type, user_id, company_id, meta) values ('match_viewed', '${U.A}', '${CO.A}', '{"matchId":"x"}')`);
  const rpcSize = await run(as(U.A), "select public.network_size() as n");
  check("network_size() が公開中の企業数を返す", !rpcSize.error && rpcSize.rows[0]?.n === 3, rpcSize.error ?? JSON.stringify(rpcSize.rows));

  console.log("\n── 運営（admin_users） ──");
  const adminSetup = `insert into public.admin_users (user_id) values ('${U.C}')`;
  const adminSees = await run(as(U.C), "select id from public.matches", adminSetup);
  check("運営は全マッチを読める", !adminSees.error && adminSees.rows.length === 1, adminSees.error ?? "");
  const adminProfiles = await run(as(U.C), "select user_id from public.user_profiles", adminSetup);
  check("運営は全プロフィールを読める", !adminProfiles.error && adminProfiles.rows.length === 3, adminProfiles.error ?? "");

  console.log("\n── 注意事項（失敗扱いにはしない） ──");
  const poison = await run(as(U.B), `update public.match_feedback set about_company_id = '${CO.C}', outcome = 'not_fit' where from_company_id = '${CO.B}'`,
    `insert into public.match_feedback (introduction_id, match_id, from_company_id, about_company_id, outcome) values ('${INTRO_AB}', '${MATCH_AB}', '${CO.B}', '${CO.A}', 'meeting')`);
  if (!poison.error && poison.affected > 0) {
    note("match_feedback: 自分のフィードバック行の about_company_id を UPDATE で無関係な企業に付け替えられる（列権限で outcome / note のみに絞ることを推奨）");
  }
  const anonCount = await run(ANON, "select public.network_size() as n");
  if (!anonCount.error) note("network_size(): anon からも実行できる（登録企業数のみ。public / anon から revoke することを推奨）");
  const selfLink = await run(as(U.C), `update public.user_profiles set company_id = '${CO.A}' where user_id = '${U.C}'`);
  if (!selfLink.error && selfLink.affected > 0) {
    note("user_profiles.company_id: 本人が任意の企業IDを書ける（権限判定には使われていないが、サーバー側では必ず companies.owner_user_id から自社を求めること）");
  }
}

main()
  .catch((e) => {
    failed++;
    console.error("✗ 検証スクリプトが異常終了しました:", e);
  })
  .finally(async () => {
    console.log(`\n${failed === 0 ? "すべて成功" : "失敗あり"}： ✓ ${passed} 件 / ✗ ${failed} 件`);
    await db?.close().catch(() => undefined);
    process.exit(failed === 0 ? 0 : 1);
  });
