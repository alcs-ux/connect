-- ════════════════════════════════════════════════════════════════
-- VIG CONNECT  0001  スキーマ
--
-- 設計方針
--  1. 「他社に見せてよい情報」と「本人だけの情報」をテーブル単位で分ける。
--     連絡先（メール・電話）は user_profiles にだけ置き、companies には置かない。
--  2. 選択肢（業種・ニーズ・提供物など）は text のID。マスタは src/lib/taxonomy.ts。
--     追加のたびにマイグレーションが要らないよう enum にはしていない。
--  3. マッチは「企業ペア」1行（matches）＋「見る側ごとのスコア」2行（match_scores）。
--     A→B と B→A で相性が違うため。
--  4. 連絡先の開示は introductions の存在だけを根拠にする（get_contact 関数）。
-- ════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── ユーザー ───────────────────────────────────────────────
create table public.users (
  id              uuid primary key references auth.users (id) on delete cascade,
  email           text not null,
  status          text not null default 'active' check (status in ('active', 'suspended')),
  onboarded_at    timestamptz,
  created_at      timestamptz not null default now(),
  last_active_at  timestamptz not null default now()
);

create table public.admin_users (
  user_id     uuid primary key references public.users (id) on delete cascade,
  role        text not null default 'operator' check (role in ('owner', 'operator')),
  created_at  timestamptz not null default now()
);

-- ── 企業（他社に見せる前提の情報のみ） ─────────────────────
create table public.companies (
  id                uuid primary key default gen_random_uuid(),
  owner_user_id     uuid not null unique references public.users (id) on delete cascade,
  name              text not null check (char_length(name) between 1 and 80),
  entity_type       text not null default 'corporation' check (entity_type in ('corporation', 'sole')),
  url               text not null default '',
  industry          text not null default 'other',
  tagline           text not null default '',
  description       text not null default '',
  prefecture        text not null default '',
  city              text not null default '',
  employees         text not null default 's2',
  founded_year      int check (founded_year is null or founded_year between 1600 and 2100),
  sales_areas       text[] not null default '{}',
  target_customers  text not null default '',
  services          text[] not null default '{}',
  status            text not null default 'active' check (status in ('active', 'suspended')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index companies_industry_idx on public.companies (industry) where status = 'active';
create index companies_prefecture_idx on public.companies (prefecture) where status = 'active';

-- 企業の非公開項目（番地・売上規模）。売上は公開設定がONのときだけ company_directory に出る。
create table public.company_private (
  company_id  uuid primary key references public.companies (id) on delete cascade,
  address     text not null default '',
  revenue     text
);

-- ── 個人プロフィール（連絡先を含む。本人のみ直接参照可） ───
create table public.user_profiles (
  user_id            uuid primary key references public.users (id) on delete cascade,
  company_id         uuid references public.companies (id) on delete set null,
  name               text not null default '',
  title              text not null default '',
  role               text not null default 'ceo',
  phone              text not null default '',
  is_decision_maker  boolean not null default false,
  updated_at         timestamptz not null default now()
);

create table public.privacy_settings (
  user_id      uuid primary key references public.users (id) on delete cascade,
  person_name  text not null default 'after_match' check (person_name in ('public', 'after_match')),
  title        text not null default 'public' check (title in ('public', 'after_match')),
  phone        text not null default 'after_match' check (phone in ('after_match', 'hidden')),
  revenue      text not null default 'public' check (revenue in ('public', 'hidden')),
  updated_at   timestamptz not null default now()
  -- 会社名は常に公開、メールは常に「紹介成立後のみ」。変更できない項目は列を持たない。
);

create table public.consents (
  user_id    uuid not null references public.users (id) on delete cascade,
  kind       text not null check (kind in ('terms', 'purpose', 'matching', 'contact_disclosure')),
  version    text not null,
  agreed_at  timestamptz not null default now(),
  primary key (user_id, kind, version)
);

create table public.business_cards (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users (id) on delete cascade,
  storage_path  text,                       -- Storage「business-cards」バケット内のパス。他ユーザーには公開しない。
  extracted     jsonb not null default '{}',
  confirmed_at  timestamptz,                -- 本人が内容を確認・確定した日時
  created_at    timestamptz not null default now()
);
create index business_cards_user_idx on public.business_cards (user_id);

-- ── NEED / OFFER（構造化データ） ───────────────────────────
create table public.needs (
  company_id         uuid primary key references public.companies (id) on delete cascade,
  categories         text[] not null default '{}',   -- 先頭ほど優先度が高い
  target_industries  text[] not null default '{}',
  target_sizes       text[] not null default '{}',
  target_areas       text[] not null default '{}',
  target_roles       text[] not null default '{}',
  issues             text[] not null default '{}',
  timing             text not null default 'research',
  budget             text,
  ideal_partner      text not null default '',
  summary            text not null default '',
  updated_at         timestamptz not null default now()
);

create table public.offers (
  company_id           uuid primary key references public.companies (id) on delete cascade,
  categories           text[] not null default '{}',
  products             text not null default '',
  ideal_customer       text not null default '',
  referable_industries text[] not null default '{}',
  partnership          text not null default '',
  online_ok            boolean not null default true,
  referral_level       text not null default 'mid' check (referral_level in ('high', 'mid', 'low')),
  summary              text not null default '',
  updated_at           timestamptz not null default now()
);

-- 検索・集計用に正規化した分類。needs / offers / companies のトリガーで自動更新する。
create table public.company_categories (
  company_id  uuid not null references public.companies (id) on delete cascade,
  kind        text not null check (kind in ('industry', 'need', 'offer')),
  category    text not null,
  position    int not null default 0,
  primary key (company_id, kind, category)
);
create index company_categories_lookup_idx on public.company_categories (kind, category);

-- ── マッチング ─────────────────────────────────────────────
create table public.matches (
  id          uuid primary key default gen_random_uuid(),
  company_a   uuid not null references public.companies (id) on delete cascade,
  company_b   uuid not null references public.companies (id) on delete cascade,
  source      text not null default 'engine' check (source in ('engine', 'admin', 'request')),
  created_by  uuid references public.users (id) on delete set null,
  admin_note  text,
  status      text not null default 'open' check (status in ('open', 'mutual', 'closed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint matches_ordered check (company_a < company_b),   -- 同じペアの重複を防ぐ
  constraint matches_pair_unique unique (company_a, company_b)
);
create index matches_b_idx on public.matches (company_b);

create table public.match_scores (
  match_id           uuid not null references public.matches (id) on delete cascade,
  viewer_company_id  uuid not null references public.companies (id) on delete cascade,
  total              int not null check (total between 0 and 100),
  breakdown          jsonb not null,          -- { needs, offer, industry, size, location, authority, timing, quality }
  links              jsonb not null default '[]',
  headline           text not null default '',
  reason             text not null default '',
  short_reason       text not null default '',
  opportunity        text not null default '',
  themes             text[] not null default '{}',
  shared_tags        text[] not null default '{}',
  reason_source      text not null default 'rule' check (reason_source in ('rule', 'ai')),
  updated_at         timestamptz not null default now(),
  primary key (match_id, viewer_company_id)
);
create index match_scores_viewer_idx on public.match_scores (viewer_company_id, total desc);

create table public.match_requests (
  id               uuid primary key default gen_random_uuid(),
  match_id         uuid not null references public.matches (id) on delete cascade,
  from_company_id  uuid not null references public.companies (id) on delete cascade,
  to_company_id    uuid not null references public.companies (id) on delete cascade,
  decision         text not null check (decision in ('interested', 'passed')),
  created_at       timestamptz not null default now(),
  unique (match_id, from_company_id)
);
create index match_requests_to_idx on public.match_requests (to_company_id) where decision = 'interested';

create table public.introductions (
  id              uuid primary key default gen_random_uuid(),
  match_id        uuid not null unique references public.matches (id) on delete cascade,
  company_a       uuid not null references public.companies (id) on delete cascade,
  company_b       uuid not null references public.companies (id) on delete cascade,
  theme           text not null default '',
  body            text not null default '',
  established_at  timestamptz not null default now()
);
create index introductions_a_idx on public.introductions (company_a);
create index introductions_b_idx on public.introductions (company_b);

-- 紹介後の結果。将来、スコアの「これまでの紹介実績」やモデル改善の教師データに使う。
create table public.match_feedback (
  id                uuid primary key default gen_random_uuid(),
  introduction_id   uuid not null references public.introductions (id) on delete cascade,
  match_id          uuid not null references public.matches (id) on delete cascade,
  from_company_id   uuid not null references public.companies (id) on delete cascade,
  about_company_id  uuid not null references public.companies (id) on delete cascade,
  outcome           text not null check (outcome in ('contacted', 'useful', 'meeting', 'deal', 'not_fit')),
  note              text not null default '',
  created_at        timestamptz not null default now(),
  unique (introduction_id, from_company_id)
);
create index match_feedback_about_idx on public.match_feedback (about_company_id);

-- つながり（無向グラフの辺）。1次・2次・3次のつながりはこの表をたどって求める。
create table public.connections (
  id               uuid primary key default gen_random_uuid(),
  company_a        uuid not null references public.companies (id) on delete cascade,
  company_b        uuid not null references public.companies (id) on delete cascade,
  origin           text not null default 'introduction' check (origin in ('introduction', 'referral', 'event')),
  introduction_id  uuid references public.introductions (id) on delete set null,
  created_at       timestamptz not null default now(),
  constraint connections_ordered check (company_a < company_b),
  constraint connections_pair_unique unique (company_a, company_b)
);
create index connections_b_idx on public.connections (company_b);

-- ── 通知・ログ・通報 ───────────────────────────────────────
create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users (id) on delete cascade,
  kind        text not null check (kind in ('new_matches', 'interest', 'introduction', 'recommendation', 'system')),
  title       text not null,
  body        text not null default '',
  href        text not null default '/home',
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

create table public.activities (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.users (id) on delete set null,
  company_id  uuid references public.companies (id) on delete set null,
  type        text not null,
  meta        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index activities_type_idx on public.activities (type, created_at desc);

create table public.reports (
  id                 uuid primary key default gen_random_uuid(),
  reporter_user_id   uuid not null references public.users (id) on delete cascade,
  target_company_id  uuid not null references public.companies (id) on delete cascade,
  reason             text not null check (reason in ('spam', 'misrepresentation', 'solicitation', 'harassment', 'other')),
  detail             text not null default '',
  status             text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz
);

-- ── トリガー ───────────────────────────────────────────────
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger companies_touch before update on public.companies for each row execute function public.touch_updated_at();
create trigger needs_touch before update on public.needs for each row execute function public.touch_updated_at();
create trigger offers_touch before update on public.offers for each row execute function public.touch_updated_at();
create trigger matches_touch before update on public.matches for each row execute function public.touch_updated_at();
create trigger user_profiles_touch before update on public.user_profiles for each row execute function public.touch_updated_at();
create trigger privacy_touch before update on public.privacy_settings for each row execute function public.touch_updated_at();

-- auth.users に行ができたら、アプリ側の行を同時に用意する
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email) values (new.id, coalesce(new.email, '')) on conflict (id) do nothing;
  insert into public.user_profiles (user_id, name)
    values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''))
    on conflict (user_id) do nothing;
  insert into public.privacy_settings (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- company_categories を needs / offers / companies に追従させる
create or replace function public.sync_company_categories() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_company uuid;
  v_kind text;
  v_list text[];
begin
  if tg_table_name = 'companies' then
    v_company := new.id; v_kind := 'industry'; v_list := array[new.industry];
  elsif tg_table_name = 'needs' then
    v_company := new.company_id; v_kind := 'need'; v_list := new.categories;
  else
    v_company := new.company_id; v_kind := 'offer'; v_list := new.categories;
  end if;
  delete from public.company_categories where company_id = v_company and kind = v_kind;
  insert into public.company_categories (company_id, kind, category, position)
    select v_company, v_kind, t.category, t.ord::int
    from unnest(v_list) with ordinality as t (category, ord)
    on conflict do nothing;
  return new;
end $$;

create trigger companies_categories after insert or update of industry on public.companies
  for each row execute function public.sync_company_categories();
create trigger needs_categories after insert or update of categories on public.needs
  for each row execute function public.sync_company_categories();
create trigger offers_categories after insert or update of categories on public.offers
  for each row execute function public.sync_company_categories();
