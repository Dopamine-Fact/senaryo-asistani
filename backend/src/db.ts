// PostgreSQL veri deposu (DATABASE_URL). Yüklenen .docx dosyaları da veritabanında (files) tutulur;
// veri klasöründeki kopyalar yalnızca önbellektir, yoksa veritabanından yeniden yazılır.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { DATA_DIR, DEFAULT_CONFIG, loadConfig, newId, now } from "./config.js";
import data from "./data.json" with { type: "json" };

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL tanımlı değil. .env dosyasına PostgreSQL bağlantı adresini yazın (ör. postgres://kullanici:sifre@sunucu:5432/veritabani).");
pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // COUNT(*) bigint döner; sayı olarak kullan
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
pool.on("error", (e) => console.error("PostgreSQL bağlantı hatası:", e.message));

type Row = Record<string, any>;
let q: pg.Pool | pg.PoolClient = pool;
// SQLite tarzı "?" yer tutucuları $1, $2… olur (SQL metinlerinde "?" yalnızca yer tutucu olarak geçer)
const pq = (sql: string, p: any[]) => { let i = 0; return q.query(sql.replace(/\?/g, () => `$${++i}`), p); };
export const all = async (sql: string, ...p: any[]) => (await pq(sql, p)).rows as Row[];
export const get = async (sql: string, ...p: any[]) => (await pq(sql, p)).rows[0] as Row | undefined;
export const run = (sql: string, ...p: any[]) => pq(sql, p);
const J = (v: unknown) => JSON.stringify(v);

// ---- varsayılan ekip yönergeleri (ilk kurulumda notlara eklenir)
const DEFAULT_GUIDELINE = "Normal olmayan, alışılmadık HER eylem tehlikeli olabilir ve çocuklara kötü örnek olur; bunları inanılmaz ısrarcı "
  + "şekilde denetle. Örnek: \"yangın tüpünü fark eder ve panzehiri yangın tüpünün içine sıkarak yanına alır\". Nesnelerin amacı dışında "
  + "kullanılması, maddelerin karıştırılması/sıkılması/içilmesi, güvenlik ekipmanlarıyla oynanması, bilinmeyen bitki-meyve-sıvının "
  + "yenmesi/içilmesi, elektrik hattına dokunulması gibi her durumu işaretle (ciddiyet: yuksek). Şüphede kalırsan işaretle ve sahnenin "
  + "amacını koruyan güvenli bir eylem öner.";
// 1.4: fiziksel tepki ve zorlama yönergeleri
const GUIDELINES_1_4 = [
  "Fiziksel / kaba tepkileri SERT şekilde denetle: karakterler dil çıkaramaz, tüküremez, taş atamaz; çimdikleme, ısırma, itip kakma, "
  + "dürtme, kaba el hareketi, geğirme gibi her fiziksel tepkiyi işaretle (ciddiyet: yuksek) ve zararsız bir tepkiyle değiştir.",
  "Karakterler başka karakterlere ZORLA bir şey yaptıramaz. İşkence, eziyet, birini alıkoymak, rehin almak, bir yere kapatmak, "
  + "bağlamak, hapsetmek kesinlikle olamaz. \"Bunu yapacaksın\", \"zorundasın\", \"emrediyorum\" gibi dayatma dili de olamaz; "
  + "rica ya da öneri diline çevir.",
];

// ---- şema ve ilk veriler: aynı anda açılan iki kurulum çakışmasın diye kilit altında
export let migrated = false;
{
  const c = await pool.connect();
  q = c;
  try {
    await c.query("SELECT pg_advisory_lock(726201)");
    await c.query(`
CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, pattern TEXT NOT NULL, match_type TEXT NOT NULL DEFAULT 'kelime',
  replacements TEXT NOT NULL DEFAULT '[]', category TEXT NOT NULL DEFAULT 'argo', reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manuel', status TEXT NOT NULL DEFAULT 'aktif', hits INTEGER NOT NULL DEFAULT 0,
  example TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, context TEXT NOT NULL DEFAULT 'kesin', lesson_id TEXT);
CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, name TEXT NOT NULL, stored_path TEXT NOT NULL,
  uploaded_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'bekliyor', status_detail TEXT NOT NULL DEFAULT '',
  previous_id TEXT, paragraph_count INTEGER NOT NULL DEFAULT 0, learned_count INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, paragraph INTEGER NOT NULL,
  start INTEGER NOT NULL, "end" INTEGER NOT NULL, original TEXT NOT NULL, suggestions TEXT NOT NULL DEFAULT '[]',
  category TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', severity TEXT NOT NULL DEFAULT 'orta',
  source TEXT NOT NULL DEFAULT 'kural', rule_id TEXT, status TEXT NOT NULL DEFAULT 'bekliyor', chosen TEXT,
  created_at TEXT NOT NULL, suggestion_info TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS idx_findings_doc ON findings(doc_id);
CREATE TABLE IF NOT EXISTS memory_files (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
  pair_key TEXT NOT NULL, stored_path TEXT NOT NULL, comment_count INTEGER NOT NULL DEFAULT 0, uploaded_at TEXT NOT NULL,
  uploaded_by TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS lessons (id TEXT PRIMARY KEY, pair_key TEXT NOT NULL, source_name TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '', note TEXT NOT NULL, anchor TEXT NOT NULL DEFAULT '', old_text TEXT NOT NULL DEFAULT '',
  new_text TEXT NOT NULL DEFAULT '', changes TEXT NOT NULL DEFAULT '[]', category TEXT NOT NULL DEFAULT 'diğer',
  outcome TEXT NOT NULL DEFAULT 'son_yok', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  edited INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_lessons_pair ON lessons(pair_key);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (name TEXT PRIMARY KEY, first_login TEXT NOT NULL, last_login TEXT NOT NULL,
  logins INTEGER NOT NULL DEFAULT 0);
-- scope: "yer" (senaryoda belirli kısım), "senaryo" (senaryonun tamamı), "genel" (Geliştir sekmesi güncellemeleri)
-- learn=1: sonraki incelemelerde yapay zekâya verilir
CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'not',
  doc_id TEXT, paragraph INTEGER, start INTEGER, "end" INTEGER, quote TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '', learn INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'acik',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_notes_doc ON notes(doc_id);
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, data BYTEA NOT NULL);`);

    // varsayılan kurallar (sürüm bazlı: yeni eklenenler mevcut kurulumlara bir kez gelir)
    const seeds = data.seedRules as any[];
    const row = await get("SELECT value FROM meta WHERE key='seed_version'");
    const version = row?.value ?? "1.1";
    const empty = !(await get("SELECT 1 FROM rules LIMIT 1"));
    if (!row) {
      for (const r of seeds.filter((x) => x.added)) {
        await run("DELETE FROM rules WHERE lower(pattern)=? AND status='aday' AND source='ogrenilen'", r.pattern.toLowerCase());
      }
    }
    const existing = new Set((await all("SELECT pattern FROM rules")).map((r) => String(r.pattern).toLowerCase()));
    for (const r of seeds) {
      const newer = r.added && r.added > version;
      if (empty || (newer && !existing.has(r.pattern.toLowerCase()))) {
        await run(`INSERT INTO rules (id, pattern, match_type, replacements, category, reason, source, status, context, created_at)
             VALUES (?,?,?,?,?,?,'varsayilan','aktif',?,?)`,
          newId(), r.pattern, r.match_type, J(r.replacements), r.category, r.reason, r.context ?? "kesin", now());
      }
    }
    const latest = seeds.reduce((m, r) => (r.added && r.added > m ? r.added : m), version);
    if (latest !== version || !row) {
      await setMeta("seed_version", latest);
      if (latest !== version) migrated = true;
    }

    // varsayılan yönergeler (bir kez eklenir; sonra Geliştir'den düzenlenebilir)
    if (!(await get("SELECT 1 FROM meta WHERE key='notlar_tasindi'"))) {
      await addGuidelines([DEFAULT_GUIDELINE]);
      await setMeta("notlar_tasindi", "1");
    }
    if (!(await get("SELECT 1 FROM meta WHERE key='yonerge_1_4'"))) {
      await addGuidelines(GUIDELINES_1_4);
      await setMeta("yonerge_1_4", "1");
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(726201)").catch(() => {});
    c.release();
    q = pool;
  }
}

function setMeta(key: string, value: string) {
  return run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value", key, value);
}
async function addGuidelines(texts: string[]) {
  for (const t of texts) {
    await run("INSERT INTO notes (id, scope, kind, text, author, learn, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)",
      newId(), "genel", "yönerge", t, "Ekip", now(), now());
  }
}

// ---------------------------------------------------------------- yardımcılar
export function defaultUser(): string {
  const a = (loadConfig().author || "").trim();
  return a && a !== DEFAULT_CONFIG.author ? a : os.userInfo().username;
}

/** Dosyanın bu veri klasöründeki önbellek yolunu verir; fetch ise ve kopya yoksa veritabanından yazar. */
async function rebase(d: Row, sub: string, fetch = true): Promise<Row> {
  const local = path.join(DATA_DIR, sub, `${d.id}.docx`);
  if (fetch && !fs.existsSync(local)) {
    const f = await get("SELECT data FROM files WHERE id=?", d.id);
    if (f) fs.writeFileSync(local, f.data);
  }
  d.stored_path = local;
  return d;
}
async function saveFile(id: string, src: string, dest: string) {
  if (src !== dest) fs.copyFileSync(src, dest);
  await run("INSERT INTO files (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data=excluded.data", id, fs.readFileSync(dest));
}
/** Yedekleme için: veritabanındaki dosya içeriği. */
export const fileData = async (id: string) => (await get("SELECT data FROM files WHERE id=?", id))?.data as Buffer | undefined;

// ---------------------------------------------------------------- AI notları
const noteRow = (r: Row): Row => ({ ...r, learn: !!r.learn });
export async function addNote(n: { scope: string; text: string; kind?: string; doc_id?: string | null; paragraph?: number | null;
  start?: number | null; end?: number | null; quote?: string; author?: string; learn?: boolean }) {
  const id = newId();
  await run(`INSERT INTO notes (id, scope, kind, doc_id, paragraph, start, "end", quote, text, author, learn, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, n.scope, n.kind ?? "not", n.doc_id ?? null, n.paragraph ?? null, n.start ?? null,
    n.end ?? null, n.quote ?? "", n.text.trim(), n.author ?? defaultUser(), n.learn === false ? 0 : 1, now(), now());
  return (await getNote(id))!;
}
export const getNote = async (id: string) => { const r = await get("SELECT * FROM notes WHERE id=?", id); return r ? noteRow(r) : null; };
export async function listNotes(o: { doc_id?: string; scope?: string; learnOnly?: boolean } = {}) {
  const w: string[] = [], p: any[] = [];
  if (o.doc_id) { w.push("doc_id=?"); p.push(o.doc_id); }
  if (o.scope) { w.push("scope=?"); p.push(o.scope); }
  if (o.learnOnly) w.push("learn=1");
  return (await all(`SELECT n.*, d.name AS doc_name FROM notes n LEFT JOIN documents d ON d.id=n.doc_id${w.length ? " WHERE " + w.map((x) => "n." + x).join(" AND ") : ""}
    ORDER BY n.created_at DESC`, ...p)).map(noteRow);
}
export async function updateNote(id: string, f: Row) {
  for (const k of ["text", "kind", "status"]) if (typeof f[k] === "string") await run(`UPDATE notes SET ${k}=?, updated_at=? WHERE id=?`, f[k], now(), id);
  if (typeof f.learn === "boolean") await run("UPDATE notes SET learn=?, updated_at=? WHERE id=?", f.learn ? 1 : 0, now(), id);
  return getNote(id);
}
export const deleteNote = (id: string) => run("DELETE FROM notes WHERE id=?", id);
/** Yapay zekânın her incelemede uyduğu ekip güncellemeleri (Geliştir sekmesi, "AI'da kullan" açık olanlar). */
export const getGuidelines = async () => (await listNotes({ scope: "genel", learnOnly: true })).reverse();

// ---------------------------------------------------------------- üyeler
export async function touchMember(name: string) {
  await run(`INSERT INTO members (name, first_login, last_login, logins) VALUES (?,?,?,1)
       ON CONFLICT (name) DO UPDATE SET last_login=excluded.last_login, logins=members.logins+1`, name, now(), now());
}
export const listMembers = () => all("SELECT * FROM members ORDER BY last_login DESC");

// ---------------------------------------------------------------- kurallar
const ruleRow = (r?: Row) => (r ? { ...r, replacements: JSON.parse(r.replacements) } : null);
export const listRules = async (status?: string) =>
  (status ? await all("SELECT * FROM rules WHERE status=? ORDER BY created_at DESC", status)
    : await all("SELECT * FROM rules ORDER BY status, created_at DESC")).map(ruleRow) as Row[];

export async function addRule(pattern: string, replacements: string[], o: {
  match_type?: string; category?: string; reason?: string; source?: string; status?: string; example?: string;
  context?: string; lesson_id?: string | null;
} = {}) {
  pattern = pattern.trim();
  const { match_type = "kelime", category = "argo", reason = "", source = "manuel", status = "aktif" } = o;
  const ex = await get("SELECT * FROM rules WHERE lower(pattern)=lower(?)", pattern);
  let id: string;
  if (ex) {
    const reps: string[] = JSON.parse(ex.replacements);
    for (const r of replacements) if (r && !reps.includes(r)) reps.push(r);
    let st = ex.status;
    if (status === "aktif" || ex.status === "pasif") st = ex.status !== "aktif" ? status : "aktif";
    await run("UPDATE rules SET replacements=?, status=?, hits=hits+?, lesson_id=COALESCE(lesson_id, ?) WHERE id=?",
      J(reps), st, source === "ogrenilen" ? 1 : 0, o.lesson_id ?? null, ex.id);
    id = ex.id;
  } else {
    id = newId();
    await run(`INSERT INTO rules (id, pattern, match_type, replacements, category, reason, source, status, example, context,
         lesson_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, pattern, match_type, J(replacements.filter(Boolean)),
      category, reason, source, status, o.example ?? "", o.context ?? "kesin", o.lesson_id ?? null, now());
  }
  return ruleRow(await get("SELECT * FROM rules WHERE id=?", id))!;
}

export async function updateRule(id: string, f: Row) {
  for (const k of ["pattern", "match_type", "replacements", "category", "reason", "status", "context"]) {
    if (f[k] !== undefined && f[k] !== null) await run(`UPDATE rules SET ${k}=? WHERE id=?`, k === "replacements" ? J(f[k]) : f[k], id);
  }
  return ruleRow(await get("SELECT * FROM rules WHERE id=?", id));
}
export const deleteRule = (id: string) => run("DELETE FROM rules WHERE id=?", id);

/** Dersten "Kural yap" ile üretilen kuralları, ders elle düzeltilince günceller. */
export async function syncLessonRules(lessonId: string, edits: { orig_old?: string; old?: string; new?: string }[]) {
  let n = 0;
  for (const e of edits) {
    const key = (e.orig_old || "").trim().toLowerCase();
    if (!key) continue;
    for (const r of await all("SELECT id FROM rules WHERE lesson_id=? AND lower(pattern)=?", lessonId, key)) {
      const o = (e.old || "").trim(), nw = (e.new || "").trim();
      if (!o) await run("DELETE FROM rules WHERE id=?", r.id);
      else await run("UPDATE rules SET pattern=?, replacements=?, match_type=? WHERE id=?", o, J([nw]),
        o.includes(" ") ? "ifade" : "kelime", r.id);
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- belgeler
export async function storeDocument(src: string, name?: string, user?: string) {
  const id = newId(), dest = path.join(DATA_DIR, "belgeler", `${id}.docx`);
  await saveFile(id, src, dest);
  await run("INSERT INTO documents (id, name, stored_path, uploaded_at, uploaded_by) VALUES (?,?,?,?,?)",
    id, name || path.basename(src), dest, now(), user ?? defaultUser());
  return (await getDocument(id))!;
}
export const getDocument = async (id: string): Promise<Row | null> => {
  const r = await get("SELECT * FROM documents WHERE id=?", id);
  return r ? rebase(r, "belgeler") : null;
};
/** Belge listesi; dosyalar indirilmez (dosyası gereken getDocument ile alır). */
export async function listDocuments(): Promise<Row[]> {
  const counts: Record<string, Row> = {};
  for (const c of await all("SELECT doc_id, status, COUNT(*) n FROM findings GROUP BY doc_id, status")) (counts[c.doc_id] ??= {})[c.status] = c.n;
  const docs = await all("SELECT * FROM documents ORDER BY uploaded_at DESC, id DESC");
  return Promise.all(docs.map(async (d) => ({ ...(await rebase(d, "belgeler", false)), counts: counts[d.id] ?? {} })));
}
export const latestDocument = async (): Promise<Row | null> => {
  const d = (await listDocuments())[0];
  return d ? getDocument(d.id) : null;
};
export async function updateDocument(id: string, f: Row) {
  for (const k of ["status", "status_detail", "previous_id", "paragraph_count", "learned_count", "name"]) {
    if (f[k] !== undefined) await run(`UPDATE documents SET ${k}=? WHERE id=?`, f[k], id);
  }
}
export async function deleteDocument(id: string) {
  await run("DELETE FROM findings WHERE doc_id=?", id);
  await run("DELETE FROM notes WHERE doc_id=? AND learn=0", id); // öğrenmede kullanılan notlar belge silinse de kalır
  await run("DELETE FROM documents WHERE id=?", id);
  await run("DELETE FROM files WHERE id=?", id);
  fs.rmSync(path.join(DATA_DIR, "belgeler", `${id}.docx`), { force: true });
}

// ---------------------------------------------------------------- bulgular
export type Sugg = string | { text: string; kaynak?: string; ref?: string; note?: string };
const findingRow = (r?: Row): Row | null => (r ? { ...r, suggestions: JSON.parse(r.suggestions), suggestion_info: JSON.parse(r.suggestion_info || "{}") } : null);

function normalize(sugg: Sugg[], def: string) {
  const texts: string[] = [], info: Row = {};
  for (const s of sugg) {
    const t = typeof s === "string" ? s : s.text ?? "";
    if (!(t in info)) {
      info[t] = typeof s === "string" ? { kaynak: def, ref: "" } : { kaynak: s.kaynak || def, ref: s.ref || "", ...(s.note ? { note: s.note } : {}) };
    }
    if (!texts.includes(t)) texts.push(t);
  }
  return { texts, info };
}

export async function addFinding(docId: string, p: number, start: number, end: number, original: string, sugg: Sugg[], o: {
  category?: string; reason?: string; severity?: string; source?: string; rule_id?: string | null; status?: string; chosen?: string | null;
} = {}) {
  const source = o.source ?? "kural", status = o.status ?? "bekliyor";
  const { texts, info } = normalize(sugg, source === "ai" ? "claude" : source);
  const ov = await get(`SELECT * FROM findings WHERE doc_id=? AND paragraph=? AND start<? AND "end">?`, docId, p, end, start);
  if (ov && status === "bekliyor") {
    const s: string[] = JSON.parse(ov.suggestions), inf = JSON.parse(ov.suggestion_info || "{}");
    for (const t of texts) { if (!s.includes(t)) s.push(t); inf[t] ??= info[t]; }
    if (end - start > ov.end - ov.start) {
      await run(`UPDATE findings SET start=?, "end"=?, original=?, suggestions=?, suggestion_info=?, reason=? WHERE id=?`,
        start, end, original, J(s), J(inf), o.reason || ov.reason, ov.id);
    } else await run("UPDATE findings SET suggestions=?, suggestion_info=?, reason=? WHERE id=?", J(s), J(inf), ov.reason || o.reason || "", ov.id);
    return (await getFinding(ov.id))!;
  }
  const id = newId();
  await run(`INSERT INTO findings (id, doc_id, paragraph, start, "end", original, suggestions, suggestion_info, category, reason,
       severity, source, rule_id, status, chosen, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, docId, p, start, end, original, J(texts), J(info), o.category ?? "", o.reason ?? "", o.severity ?? "orta",
    source, o.rule_id ?? null, status, o.chosen ?? null, now());
  return (await getFinding(id))!;
}
export const deleteFindingsInRange = (docId: string, p: number, s: number, e: number) =>
  run(`DELETE FROM findings WHERE doc_id=? AND paragraph=? AND start<? AND "end">?`, docId, p, Math.max(e, s + 1), s);
export const listFindings = async (docId: string, status?: string) =>
  (status ? await all("SELECT * FROM findings WHERE doc_id=? AND status=? ORDER BY paragraph, start", docId, status)
    : await all("SELECT * FROM findings WHERE doc_id=? ORDER BY paragraph, start", docId)).map(findingRow) as Row[];
export const getFinding = async (id: string) => findingRow(await get("SELECT * FROM findings WHERE id=?", id));
export async function decideFinding(id: string, status: string, chosen?: string | null) {
  await run("UPDATE findings SET status=?, chosen=? WHERE id=?", status, status === "kabul" ? chosen ?? "" : null, id);
  return getFinding(id);
}
export async function addSuggestions(id: string, sugg: Sugg[]) {
  const f = await getFinding(id);
  if (!f) return null;
  const { texts, info } = normalize(sugg, "claude");
  for (const t of texts) { if (!f.suggestions.includes(t)) f.suggestions.push(t); f.suggestion_info[t] ??= info[t]; }
  await run("UPDATE findings SET suggestions=?, suggestion_info=? WHERE id=?", J(f.suggestions), J(f.suggestion_info), id);
  return getFinding(id);
}
export const clearFindings = (docId: string, source?: string) => source
  ? run("DELETE FROM findings WHERE doc_id=? AND source=? AND status='bekliyor'", docId, source)
  : run("DELETE FROM findings WHERE doc_id=? AND status='bekliyor'", docId);

// ---------------------------------------------------------------- bellek
const lessonRow = (r: Row): Row => ({ ...r, changes: JSON.parse(r.changes), active: !!r.active, edited: !!r.edited });

export async function addMemoryFile(src: string, name: string, kind: string, pairKey: string, commentCount: number, user?: string) {
  const id = newId(), dest = path.join(DATA_DIR, "bellek", `${id}.docx`);
  await saveFile(id, src, dest);
  for (const old of await all("SELECT id FROM memory_files WHERE pair_key=? AND kind=?", pairKey, kind)) {
    fs.rmSync(path.join(DATA_DIR, "bellek", `${old.id}.docx`), { force: true });
    await run("DELETE FROM memory_files WHERE id=?", old.id);
    await run("DELETE FROM files WHERE id=?", old.id);
  }
  await run(`INSERT INTO memory_files (id, name, kind, pair_key, stored_path, comment_count, uploaded_at, uploaded_by)
       VALUES (?,?,?,?,?,?,?,?)`, id, name, kind, pairKey, dest, commentCount, now(), user ?? defaultUser());
}
/** fetch=false: yalnızca kayıtlar (dosyalar indirilmez). */
export const memoryFiles = async (pairKey?: string, fetch = true): Promise<Row[]> =>
  Promise.all((pairKey ? await all("SELECT * FROM memory_files WHERE pair_key=?", pairKey)
    : await all("SELECT * FROM memory_files ORDER BY pair_key, kind")).map((r) => rebase(r, "bellek", fetch)));

export async function memoryPairs() {
  const pairs: Record<string, Row> = {};
  for (const f of await memoryFiles(undefined, false)) {
    const p = (pairs[f.pair_key] ??= { pair_key: f.pair_key, notlu: null, son: null });
    p[f.kind] = { id: f.id, name: f.name, uploaded_at: f.uploaded_at, comment_count: f.comment_count, uploaded_by: f.uploaded_by || "" };
  }
  for (const r of await all("SELECT pair_key, outcome, COUNT(*) n FROM lessons GROUP BY pair_key, outcome")) {
    if (pairs[r.pair_key]) (pairs[r.pair_key].outcomes ??= {})[r.outcome] = r.n;
  }
  return Object.values(pairs).sort((a, b) => a.pair_key.localeCompare(b.pair_key));
}
export async function deleteMemoryPair(pairKey: string) {
  for (const f of await memoryFiles(pairKey, false)) {
    fs.rmSync(f.stored_path, { force: true });
    await run("DELETE FROM files WHERE id=?", f.id);
  }
  await run("DELETE FROM memory_files WHERE pair_key=?", pairKey);
  await run("DELETE FROM lessons WHERE pair_key=?", pairKey);
}

export async function replaceLessons(pairKey: string, lessons: Row[]) {
  const kept = new Map((await all("SELECT id, note, anchor, active, category, edited, changes, outcome FROM lessons WHERE pair_key=?", pairKey))
    .map((r) => [`${r.note}\u0000${r.anchor}`, r]));
  await run("DELETE FROM lessons WHERE pair_key=?", pairKey);
  for (const l of lessons) {
    const prev = kept.get(`${l.note}\u0000${l.anchor}`); // aynı kimlik: bağlı kurallar kopmasın; elle düzeltme korunur
    const edited = prev?.edited ?? 0;
    await run(`INSERT INTO lessons (id, pair_key, source_name, author, note, anchor, old_text, new_text, changes, category, outcome,
         active, edited, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      prev?.id ?? newId(), pairKey, l.source_name, l.author ?? "", l.note, l.anchor, l.old_text, l.new_text,
      edited ? prev!.changes : J(l.changes), prev?.category ?? l.category, edited ? prev!.outcome : l.outcome,
      prev?.active ?? 1, edited, now());
  }
  return lessons.length;
}
export const listLessons = async (activeOnly = false) =>
  (await all(`SELECT * FROM lessons${activeOnly ? " WHERE active=1" : ""} ORDER BY created_at DESC, pair_key`)).map(lessonRow);
export async function updateLesson(id: string, o: { active?: boolean | null; category?: string | null; changes?: Row[] | null }) {
  if (o.changes) {
    const clean = o.changes.map((c) => ({ old: String(c.old ?? "").trim(), new: String(c.new ?? "").trim() })).filter((c) => c.old || c.new);
    await run("UPDATE lessons SET changes=?, edited=1, outcome=? WHERE id=?", J(clean), clean.length ? "revize" : "degismedi", id);
  }
  if (o.active !== undefined && o.active !== null) await run("UPDATE lessons SET active=? WHERE id=?", o.active ? 1 : 0, id);
  if (o.category) await run("UPDATE lessons SET category=? WHERE id=?", o.category, id);
  const r = await get("SELECT * FROM lessons WHERE id=?", id);
  return r ? lessonRow(r) : null;
}
