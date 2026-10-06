/** マッチングの健全性チェック： npm run test:matching */
import { buildSeed } from "../src/lib/data/seed";
import { scorePair, RECOMMEND_THRESHOLD } from "../src/lib/matching/engine";
import { explain } from "../src/lib/matching/explain";

const db = buildSeed(new Date("2026-10-06T10:00:00Z"));
const party = (id: string) => {
  const company = db.companies.find((c) => c.id === id)!;
  const u = db.users.find((x) => x.id === company.ownerUserId)!;
  return { company, rep: { role: u.role, isDecisionMaker: u.isDecisionMaker } };
};
const only = process.argv[2];
let total = 0, over = 0;
for (const v of db.companies) {
  const rows = db.companies.filter((t) => t.id !== v.id).map((t) => {
    const s = scorePair(party(v.id), party(t.id));
    return { t, s, ex: explain(party(v.id), party(t.id), s) };
  }).sort((a, b) => b.s.total - a.s.total);
  total += rows.length; over += rows.filter((r) => r.s.total >= RECOMMEND_THRESHOLD).length;
  if (only ? v.name.includes(only) : v === db.companies[0]) {
    console.log(`\n■ ${v.name} から見た相性`);
    for (const r of rows.slice(0, 12)) {
      console.log(`${String(r.s.total).padStart(3)}  ${r.t.name}  [${r.ex.headline}]  N${r.s.breakdown.needs} O${r.s.breakdown.offer} I${r.s.breakdown.industry}`);
      console.log(`     ${r.ex.reason}`);
      console.log(`     tags: ${r.ex.sharedTags.join(" / ")} | themes: ${r.ex.themes.join(" / ")}`);
    }
    console.log("  ...下位:", rows.slice(-4).map((r) => `${r.s.total} ${r.t.name}`).join(" | "));
  }
}
const all = db.companies.flatMap((v) => db.companies.filter((t) => t.id !== v.id).map((t) => scorePair(party(v.id), party(t.id)).total));
console.log(`\n組み合わせ ${total} / おすすめ基準(${RECOMMEND_THRESHOLD})以上 ${over} / 最高 ${Math.max(...all)} / 最低 ${Math.min(...all)}`);
