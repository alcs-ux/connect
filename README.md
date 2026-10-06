# VIG CONNECT

名刺交換で終わらない。次のビジネスにつながる。
登録企業の「求めているもの（Need）」と「提供できるもの（Offer）」を照らし合わせ、相性の良い企業同士を紹介する法人向けマッチングネットワークです。

- 設計の全体像と判断理由 → [`docs/DESIGN.md`](docs/DESIGN.md)
- 公開前に必ず対応すること → このREADMEの「公開前チェックリスト」

## すぐ動かす（デモモード）

```bash
npm install
npm run dev        # http://localhost:3000
```

環境変数を何も設定しなければ**デモモード**で起動します。

- データはブラウザの localStorage にだけ保存されます（サーバーには何も保存しません）。
- 架空の登録企業26社が入っています。ログイン画面の「デモアカウントで見る」で、利用中の状態（おすすめ9社・興味3社・紹介成立2件）をすぐ確認できます。「運営画面を見る」で管理画面に入れます。
- 新規登録からの流れも最後まで動きます。「話してみたい」を押すと、相性が一定以上の相手は約7秒後に承認を返します（デモ用の再現。本番にはありません）。
- 名刺の読み取り・会社サイトからの下書きは、生成AIのキーが無いと動きません。その場合、名刺は**見本の読み取り結果**が入り、画面にその旨を表示します。

## 本番モード（Supabase）

1. Supabaseでプロジェクトを作成し、`supabase/migrations/0001_schema.sql` → `0002_rls.sql` の順に実行（SQL Editor か `supabase db push`）。
2. Authentication → Providers で Email と Google を有効化。Redirect URL に `https://<ドメイン>/auth/callback` を追加。
3. `.env.example` を `.env.local` にコピーして値を設定（Vercelでは Project Settings → Environment Variables）。
4. 運営アカウントを作る：通常どおり登録したあと `npm run seed:supabase -- --make-admin <メールアドレス>`。
5. （任意）デモ企業を投入：`npm run seed:supabase -- --yes-seed-demo-data`。**架空データです。本番のネットワークには入れないでください。**

| 変数 | 用途 |
| --- | --- |
| `NEXT_PUBLIC_SITE_URL` | OGP・sitemap・認証の戻り先 |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 設定すると本番モードになる |
| `SUPABASE_SERVICE_ROLE_KEY` | サーバー専用。マッチング生成・回答・管理操作。**`NEXT_PUBLIC_` を付けない** |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | 名刺読み取り、会社情報の下書き、理由・紹介文の文章化。無くても動く（ルールベースに切り替わる） |
| `AI_ALLOW_DEMO` | デモモードでも生成AIを使う場合のみ `true`（認証が無いので公開URLでは非推奨） |

デプロイは Vercel にそのまま載ります（`npm run build`）。Cloudflare で動かす場合は OpenNext + Workers が必要です。

## 確認用コマンド

```bash
npm run typecheck       # 型チェック
npm run test:matching   # スコアリングの結果を一覧表示
npm run test:sql        # マイグレーションとRLSを、インメモリのPostgres（PGlite）で検証（122項目）
npm run build && PORT=3100 npm start &
npm run test:e2e        # 登録→診断→おすすめ→相互承認→紹介→管理画面 を通しで操作（スクリーンショットは scripts/shots/）
```

`test:e2e` は Playwright の Chromium を使います。パスが違う場合は `CHROME_PATH=/path/to/chrome` を指定してください。

## ディレクトリ

```
src/app/(marketing)      LP
src/app/(auth)           ログイン・登録
src/app/onboarding       名刺 → 企業情報 → ニーズ診断 → 確認 → 分析
src/app/(app)            ホーム / おすすめ / マッチ詳細 / 紹介 / ネットワーク / プロフィール / 通知
src/app/admin            運営画面
src/app/api              生成AI（ai/*）、マッチングの書き込み（matches/*, matching/run）、管理（admin/*）
src/components/ui        デザインシステムの部品
src/lib/taxonomy.ts      選択肢マスタと Need→Offer 対応表
src/lib/matching         スコアリング（engine.ts）と理由の文章化（explain.ts）
src/lib/data             Repository（local = デモ / supabase = 本番）と TanStack Query のフック
supabase/migrations      スキーマとRLS
```

## 検証できていること／できていないこと

**できていること（このリポジトリのコマンドで再現可能）**
- デモモードの全画面を、スマホ幅・PC幅で通し操作（67画面、コンソールエラー0）。
- マイグレーション2本が無修正で適用でき、公開範囲のルール122項目がRLSで守られること（PGlite上）。
- 型チェックと本番ビルド。

**できていないこと**
- **実際のSupabaseプロジェクトに対する動作確認**（Auth・Storage・PostgREST）。本番モードのコードは型と、PGlite上の模擬環境でのみ確認しています。初回接続時に、登録→おすすめ→相互承認→紹介を一度通してください。
- **実際の生成AI APIの呼び出し**（APIキーが無い環境で開発したため）。JSON Schemaでの構造化・失敗時のフォールバックは実装済みですが、読み取り精度や文章の質は未確認です。
- Google ログイン、確認メール経由の登録。
- iOS Safari / Android Chrome の実機（確認は Chromium のスマホ幅エミュレーションのみ）。

## 公開前チェックリスト

- [ ] `/terms` `/privacy` はひな形です。運営会社名・窓口・委託先（Supabase、生成AIの提供元、Vercel）を入れ、専門家の確認を受ける。
- [ ] 生成AIに名刺画像・企業プロフィールを送ることを、プライバシーポリシーと同意文言に明記する（現在の文言は一般的な表現）。
- [ ] API に流量制限が無い。Vercel の Firewall か Upstash などでレート制限を入れる（特に `/api/ai/*`）。
- [ ] 通知はアプリ内のみ。メール／LINE通知は未実装（`notifications` テーブルを起点に追加できる）。
- [ ] 複数ステップの書き込み（相互承認→紹介作成→通知）は1トランザクションではない。各ステップは冪等だが、厳密にするならPostgres関数にまとめる。
- [ ] おすすめ生成は全社を読み込んで計算している。数百社までは問題ないが、それ以上は `company_categories` で候補を絞るSQLに置き換える。
- [ ] 停止中のユーザーは画面・APIでは拒否されるが、RLS上は自分の行を読める。厳密にするならRLSにも `is_active_user()` を足す。
- [ ] デモ企業の社名は架空として作成したが、実在企業との重複は調査していない。対外デモの前に確認する。
