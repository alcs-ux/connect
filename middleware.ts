/**
 * 認証セッション（Cookie）の更新だけを行う。
 * 画面の出し分け・リダイレクトはクライアント側のシェルが担当するので、ここでは行わない。
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isSupabaseConfigured, supabaseEnv } from "@/lib/supabase/config";

export async function middleware(request: NextRequest) {
  if (!isSupabaseConfigured()) return NextResponse.next(); // デモモード

  let response = NextResponse.next({ request });
  const { url, anonKey } = supabaseEnv();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list, headers) => {
        // 更新されたトークンを、このリクエストの後続処理（Route Handler）とブラウザの両方に渡す
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
        // トークンを含む応答をCDNなどが共有キャッシュしないよう、ライブラリ指定のヘッダーを付ける
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
      },
    },
  });

  try {
    // getUser() がトークンを検証し、期限が近ければ更新する。createServerClient との間に処理を挟まないこと。
    await supabase.auth.getUser();
  } catch {
    // Auth サーバーに届かなくても画面は返す（未ログイン扱いになる）
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff|woff2|ttf|otf)$).*)"],
};
