-- ════════════════════════════════════════════════════════════════
-- VIG CONNECT  0002  行レベルセキュリティと公開用ビュー
--
-- 原則
--  ・ベーステーブルは「本人（自社）の行だけ」。他社の情報は必ず
--    company_directory ビュー / get_contact() 関数を経由して読む。
--  ・マッチングの書き込み（生成・回答・紹介成立）はクライアントから直接行わせない。
--    Route Handler が service_role で実行する（RLSに INSERT/UPDATE ポリシーを置かない）。
--  ・service_role は RLS を通らない。キーはサーバーの環境変数にだけ置く。
-- ════════════════════════════════════════════════════════════════

-- ── 判定用の関数 ───────────────────────────────────────────
create or replace function public.my_company_id() returns uuid
language sql stable security definer set search_path = public as $$
  select c.id from public.companies c where c.owner_user_id = auth.uid()
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admin_users a where a.user_id = auth.uid())
$$;

create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users u where u.id = auth.uid() and u.status = 'active')
$$;

-- 紹介が成立している相手かどうか。連絡先開示の唯一の根拠。
create or replace function public.is_introduced(p_company uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.introductions i
    where (i.company_a = public.my_company_id() and i.company_b = p_company)
       or (i.company_b = public.my_company_id() and i.company_a = p_company)
  )
$$;

-- ── RLS 有効化 ─────────────────────────────────────────────
alter table public.users              enable row level security;
alter table public.admin_users        enable row level security;
alter table public.companies          enable row level security;
alter table public.company_private    enable row level security;
alter table public.user_profiles      enable row level security;
alter table public.privacy_settings   enable row level security;
alter table public.consents           enable row level security;
alter table public.business_cards     enable row level security;
alter table public.needs              enable row level security;
alter table public.offers             enable row level security;
alter table public.company_categories enable row level security;
alter table public.matches            enable row level security;
alter table public.match_scores       enable row level security;
alter table public.match_requests     enable row level security;
alter table public.introductions      enable row level security;
alter table public.match_feedback     enable row level security;
alter table public.connections        enable row level security;
alter table public.notifications      enable row level security;
alter table public.activities         enable row level security;
alter table public.reports            enable row level security;

-- ── users / admin_users ────────────────────────────────────
create policy users_select_self on public.users for select using (id = auth.uid() or public.is_admin());
create policy users_touch_self on public.users for update using (id = auth.uid()) with check (id = auth.uid());
-- status は本人が書き換えられない（列権限で制限）
revoke update on public.users from authenticated;
grant update (onboarded_at, last_active_at) on public.users to authenticated;

create policy admin_users_select on public.admin_users for select using (user_id = auth.uid() or public.is_admin());

-- ── companies と付随テーブル（自社のみ） ───────────────────
create policy companies_select_own on public.companies for select using (owner_user_id = auth.uid() or public.is_admin());
create policy companies_insert_own on public.companies for insert with check (owner_user_id = auth.uid() and public.is_active_user());
create policy companies_update_own on public.companies for update using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy companies_delete_own on public.companies for delete using (owner_user_id = auth.uid());
-- status（停止）は運営のみが変更できる
revoke update on public.companies from authenticated;
grant update (name, entity_type, url, industry, tagline, description, prefecture, city, employees, founded_year, sales_areas, target_customers, services)
  on public.companies to authenticated;

create policy company_private_own on public.company_private for all
  using (company_id = public.my_company_id() or public.is_admin())
  with check (company_id = public.my_company_id());

create policy needs_own on public.needs for all
  using (company_id = public.my_company_id() or public.is_admin())
  with check (company_id = public.my_company_id());

create policy offers_own on public.offers for all
  using (company_id = public.my_company_id() or public.is_admin())
  with check (company_id = public.my_company_id());

-- 分類は連絡先を含まないので、ログイン済みなら読める（検索の絞り込み・集計に使う）
create policy company_categories_read on public.company_categories for select using (auth.uid() is not null);

-- ── 個人情報（本人のみ） ───────────────────────────────────
create policy user_profiles_own on public.user_profiles for all
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid());

create policy privacy_own on public.privacy_settings for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy consents_select_own on public.consents for select using (user_id = auth.uid() or public.is_admin());
create policy consents_insert_own on public.consents for insert with check (user_id = auth.uid());
create policy business_cards_own on public.business_cards for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── マッチング（読み取りのみ。書き込みはサーバー経由） ─────
create policy matches_select_party on public.matches for select
  using (company_a = public.my_company_id() or company_b = public.my_company_id() or public.is_admin());

-- スコアは「自分から見た値」だけ。相手から見た自社の点数は見せない。
create policy match_scores_select_viewer on public.match_scores for select
  using (viewer_company_id = public.my_company_id() or public.is_admin());

-- 自分の回答はすべて見える。相手の回答は「話してみたい」だけ見える（見送りは相手に伝えない）。
create policy match_requests_select on public.match_requests for select
  using (
    from_company_id = public.my_company_id()
    or (to_company_id = public.my_company_id() and decision = 'interested')
    or public.is_admin()
  );

create policy introductions_select_party on public.introductions for select
  using (company_a = public.my_company_id() or company_b = public.my_company_id() or public.is_admin());

create policy match_feedback_select_own on public.match_feedback for select
  using (from_company_id = public.my_company_id() or public.is_admin());
create policy match_feedback_insert_own on public.match_feedback for insert
  with check (
    from_company_id = public.my_company_id()
    and exists (
      select 1 from public.introductions i
      where i.id = introduction_id and i.match_id = match_feedback.match_id
        and ((i.company_a = from_company_id and i.company_b = about_company_id)
          or (i.company_b = from_company_id and i.company_a = about_company_id))
    )
  );
create policy match_feedback_update_own on public.match_feedback for update
  using (from_company_id = public.my_company_id()) with check (from_company_id = public.my_company_id());

-- つながりのグラフ全体は見せない。自社が端点の辺だけ。距離は connection_degrees() で取得する。
create policy connections_select_party on public.connections for select
  using (company_a = public.my_company_id() or company_b = public.my_company_id() or public.is_admin());

-- ── 通知・ログ・通報 ───────────────────────────────────────
create policy notifications_select_own on public.notifications for select using (user_id = auth.uid());
create policy notifications_update_own on public.notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

create policy activities_insert_own on public.activities for insert with check (user_id = auth.uid());
create policy activities_select_admin on public.activities for select using (public.is_admin());

create policy reports_insert_own on public.reports for insert with check (reporter_user_id = auth.uid() and public.is_active_user());
create policy reports_select on public.reports for select using (reporter_user_id = auth.uid() or public.is_admin());

-- ════════════════════════════════════════════════════════════════
-- 公開用ビュー：他社に見せてよい範囲だけを、公開設定を適用して返す
--   ・メール、電話、番地は列として存在しない
--   ・氏名／役職／売上規模は、本人の公開設定か、紹介成立済みのときだけ値が入る
-- ビューは所有者権限で実行される（security_invoker = false）ため、
-- ここに列を足すときは「全登録者に見えてよいか」を必ず確認すること。
-- ════════════════════════════════════════════════════════════════
create or replace view public.company_directory
with (security_invoker = false) as
select
  c.id, c.name, c.entity_type, c.url, c.industry, c.tagline, c.description, c.prefecture, c.city,
  c.employees, c.founded_year, c.sales_areas, c.target_customers, c.services, c.status, c.created_at, c.updated_at,
  case when coalesce(ps.revenue, 'public') = 'public' then cp.revenue end as revenue,
  case when coalesce(ps.person_name, 'after_match') = 'public' or public.is_introduced(c.id) or c.owner_user_id = auth.uid()
       then up.name end as representative_name,
  case when coalesce(ps.title, 'public') = 'public' or public.is_introduced(c.id) or c.owner_user_id = auth.uid()
       then up.title end as representative_title,
  coalesce(up.role, 'staff') as representative_role,
  coalesce(up.is_decision_maker, false) as representative_is_decision_maker,
  to_jsonb(n) - 'company_id' as need,
  to_jsonb(o) - 'company_id' as offer
from public.companies c
left join public.company_private cp on cp.company_id = c.id
left join public.user_profiles up on up.user_id = c.owner_user_id
left join public.privacy_settings ps on ps.user_id = c.owner_user_id
left join public.needs n on n.company_id = c.id
left join public.offers o on o.company_id = c.id
where auth.uid() is not null
  and (c.status = 'active' or c.owner_user_id = auth.uid());

revoke all on public.company_directory from anon;
grant select on public.company_directory to authenticated;

-- ── 連絡先の開示：紹介が成立している相手（または自社）だけ ──
create or replace function public.get_contact(p_company uuid)
returns table (company_id uuid, company_name text, person_name text, title text, email text, phone text, url text)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, up.name, up.title, u.email,
         case when coalesce(ps.phone, 'after_match') = 'hidden' and c.owner_user_id <> auth.uid() then null else nullif(up.phone, '') end,
         c.url
  from public.companies c
  join public.users u on u.id = c.owner_user_id
  left join public.user_profiles up on up.user_id = c.owner_user_id
  left join public.privacy_settings ps on ps.user_id = c.owner_user_id
  where c.id = p_company
    and (c.owner_user_id = auth.uid() or public.is_introduced(p_company))
$$;
revoke all on function public.get_contact(uuid) from public, anon;
grant execute on function public.get_contact(uuid) to authenticated;

-- ── つながりの距離（1〜3次）。グラフそのものは返さず、距離と経由先だけ返す ──
create or replace function public.connection_degrees()
returns table (company_id uuid, degree int, via_company_id uuid)
language sql stable security definer set search_path = public as $$
  with recursive edges as (
    select company_a as src, company_b as dst from public.connections
    union all
    select company_b, company_a from public.connections
  ),
  walk as (
    select e.dst as company_id, 1 as degree, null::uuid as via_company_id, array[public.my_company_id(), e.dst] as path
    from edges e where e.src = public.my_company_id()
    union all
    select e.dst, w.degree + 1, coalesce(w.via_company_id, w.company_id), w.path || e.dst
    from walk w join edges e on e.src = w.company_id
    where w.degree < 3 and not e.dst = any (w.path)
  )
  select distinct on (company_id) company_id, degree, via_company_id
  from walk
  order by company_id, degree
$$;
revoke all on function public.connection_degrees() from public, anon;
grant execute on function public.connection_degrees() to authenticated;

-- ── 登録企業数（ホーム画面の「ネットワーク」） ─────────────
create or replace function public.network_size() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.companies where status = 'active'
$$;
grant execute on function public.network_size() to authenticated;

-- ── Storage：名刺画像は本人のフォルダにだけ読み書きできる ──
insert into storage.buckets (id, name, public) values ('business-cards', 'business-cards', false)
  on conflict (id) do nothing;

create policy business_cards_storage_rw on storage.objects for all to authenticated
  using (bucket_id = 'business-cards' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'business-cards' and (storage.foldername(name))[1] = auth.uid()::text);

-- ── 追補 ───────────────────────────────────────────────────
-- フィードバックは結果とメモだけ書き換えられる（対象企業の付け替えで他社の評価を下げられないように）
revoke update on public.match_feedback from authenticated;
grant update (outcome, note) on public.match_feedback to authenticated;

-- 登録企業数は未ログインには返さない
revoke all on function public.network_size() from public, anon;

-- 連絡先の一括取得（紹介一覧用）。開示条件は get_contact と同じ。
create or replace function public.get_contacts(p_companies uuid[])
returns table (company_id uuid, company_name text, person_name text, title text, email text, phone text, url text)
language sql stable security definer set search_path = public as $$
  select c.* from unnest(p_companies) as x (id) cross join lateral public.get_contact(x.id) c
$$;
revoke all on function public.get_contacts(uuid[]) from public, anon;
grant execute on function public.get_contacts(uuid[]) to authenticated;
