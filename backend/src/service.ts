// Arayüz ve MCP'nin ortak iş akışları.
import path from "node:path";
import { DATA_DIR, loadConfig } from "./config.js";
import * as db from "./db.js";
import { aiReady, analyze, applyNote as aiApplyNote } from "./ai.js";
import { applyChanges, readTexts, smartRemovalRange, trackedChangeVersions } from "./docx.js";
import { pairsBetweenVersions, pairsToRules, similarity, suggestionIndex, suggestionsFor } from "./memory.js";
import { diffPairs, matchCase, scanParagraph, type Pair } from "./text.js";

export { aiReady };

async function saveLearned(pairs: Pair[], label: string) {
  const status = loadConfig().auto_learn ? "aktif" : "aday";
  const rules = pairsToRules(pairs);
  for (const r of rules) {
    await db.addRule(r.pattern, r.replacements, { match_type: r.match_type, category: "öğrenilen", source: "ogrenilen", status,
      reason: `${label} içinde ekip tarafından değiştirildi.`, example: r.example });
  }
  return rules.length;
}

export const learnFromVersions = async (oldFile: string, newFile: string, label = "Sürüm karşılaştırması") =>
  saveLearned(await pairsBetweenVersions(oldFile, newFile), label);

// ---------------------------------------------------------------- tarama
const PUNCT = ".,;:!?…";
const fitPunct = (orig: string, s: string) => {
  s = s.trim();
  if (!PUNCT.includes(orig.at(-1) ?? "")) s = s.replace(/[.,;:!?… ]+$/, "");
  if (!PUNCT.includes(orig[0] ?? "")) s = s.replace(/^[.,;:!?… ]+/, "");
  return s;
};

export async function scanRules(docId: string) {
  const doc = (await db.getDocument(docId))!, texts = await readTexts(doc.stored_path), rules = await db.listRules("aktif"), idx = await suggestionIndex();
  await db.clearFindings(docId, "kural");
  let n = 0;
  for (const [pi, text] of texts.entries()) {
    if (!text.trim()) continue;
    for (const h of scanParagraph(text, rules)) {
      // önce ekibin geçmişte aynı ifade için yaptığı düzeltmeler (Bellek), sonra kural önerileri
      const sugg = [...suggestionsFor(h.original, idx).map((m) => ({ ...m, text: matchCase(h.original, fitPunct(h.original, m.text)) })),
        ...h.suggestions.map((t) => ({ text: t, kaynak: "kural", ref: "" }))];
      await db.addFinding(docId, pi, h.start, h.end, h.original, sugg, { category: h.category, reason: h.reason, severity: h.severity, rule_id: h.rule_id });
      n++;
    }
  }
  return n;
}

export async function scanAi(docId: string, progress?: (d: number, t: number) => void) {
  const doc = (await db.getDocument(docId))!, texts = await readTexts(doc.stored_path);
  await db.clearFindings(docId, "ai");
  const found = await analyze(texts, progress, await db.listNotes({ doc_id: docId }));
  for (const f of found) await db.addFinding(docId, f.paragraph, f.start, f.end, f.original, f.suggestions, { category: f.category, reason: f.reason, severity: f.severity, source: "ai" });
  return found.length;
}

let rescanning = false, again = false;
/** Kurallar/Bellek değişince bekleyen kural bulgularını tazeler; üst üste binen istekler birleştirilir. */
export async function rescanAllRules() {
  if (rescanning) { again = true; return; }
  rescanning = true;
  try {
    do { again = false; for (const d of await db.listDocuments()) await scanRules(d.id).catch(() => {}); } while (again);
  } finally { rescanning = false; }
}

async function findPrevious(doc: any, texts: string[]) {
  let best: any = null, bestSim = 0.6;
  for (const d of (await db.listDocuments()).slice(0, 30)) {
    if (d.id === doc.id || d.uploaded_at > doc.uploaded_at) continue;
    const o = (await db.getDocument(d.id))!; // dosyası önbellekte yoksa veritabanından alınır
    const sim = similarity(await readTexts(o.stored_path).catch(() => []), texts);
    if (sim > bestSim && sim < 0.9999) { best = o; bestSim = sim; }
  }
  return best;
}

/** Yükleme sonrası tam akış: öğren -> kural taraması -> (varsa) OpenAI taraması. */
export async function processDoc(docId: string, runAi = true) {
  const doc = (await db.getDocument(docId))!;
  const st = (status: string, detail = "") => db.updateDocument(docId, { status, status_detail: detail });
  try {
    await st("analiz", "Belge okunuyor");
    const texts = await readTexts(doc.stored_path);
    await db.updateDocument(docId, { paragraph_count: texts.length });
    await st("analiz", "Değişikliklerden öğreniliyor");
    let learned = 0;
    const tracked = await trackedChangeVersions(doc.stored_path);
    if (tracked.length) learned += await saveLearned(tracked.flatMap(([, o, n]) => diffPairs(o, n)), `'${doc.name}' (izlenen değişiklikler)`);
    const prev = await findPrevious(doc, texts);
    if (prev) {
      await db.updateDocument(docId, { previous_id: prev.id });
      learned += await learnFromVersions(prev.stored_path, doc.stored_path, `'${prev.name}' -> '${doc.name}'`);
    }
    await db.updateDocument(docId, { learned_count: learned });
    await st("analiz", "Kurallar taranıyor");
    await scanRules(docId);
    if (runAi && aiReady()) {
      try { await scanAi(docId, (d, t) => void st("analiz", `OpenAI inceliyor (${d}/${t})`).catch(() => {})); }
      catch (e: any) { return st("hazir", `OpenAI hatası: ${e.message}`); }
    }
    await st("hazir");
  } catch (e: any) { await st("hata", String(e.message ?? e)); }
}

export async function ingest(file: string, name?: string, runAi = true, user?: string) {
  const doc = await db.storeDocument(file, name, user);
  await processDoc(doc.id, runAi);
  return (await db.getDocument(doc.id))!;
}

// ---------------------------------------------------------------- kararlar ve düzenleme
export async function decide(id: string, action: string, text?: string | null, remember = true) {
  const f = await db.getFinding(id);
  if (!f) return null;
  if (action === "red") return db.decideFinding(id, "red");
  if (action === "geri") return db.decideFinding(id, "bekliyor");
  const chosen = text ?? f.suggestions[0] ?? "";
  const res = await db.decideFinding(id, "kabul", chosen);
  if (remember && f.source !== "kural" && f.original.split(/\s+/).length <= 6) {
    await db.addRule(f.original, [chosen], { match_type: f.original.includes(" ") ? "ifade" : "kelime", category: f.category || "öğrenilen",
      reason: f.reason, source: "ogrenilen", status: loadConfig().auto_learn ? "aktif" : "aday", example: f.original });
  }
  return res;
}

export function previewParagraph(text: string, findings: any[]) {
  for (const f of findings.filter((x) => x.status === "kabul").sort((a, b) => b.start - a.start)) {
    let s = f.start, e = f.end, nw: string = f.chosen ?? "";
    if (text.slice(s, e) !== f.original) continue;
    if (nw === "") [s, e, nw] = smartRemovalRange(text, s, e);
    text = text.slice(0, s) + nw + text.slice(e);
  }
  return text;
}

/** Değişen kelimeleri bulur (kelime sınırına genişletilmiş): [eskiBaş, eskiSon, yeniBaş, yeniSon] */
function wordDiff(a: string, b: string) {
  let p = 0, s = 0;
  while (p < Math.min(a.length, b.length) && a[p] === b[p]) p++;
  while (s < Math.min(a.length, b.length) - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  let os = p, oe = a.length - s, ns = p, ne = b.length - s;
  while (os > 0 && !/\s/.test(a[os - 1])) { os--; ns--; }
  while (oe < a.length && !/\s/.test(a[oe])) { oe++; ne++; }
  return [os, oe, ns, ne];
}

/** Editörün senaryoda doğrudan yazdığı paragrafı, yalnızca değişen kelimeler olarak kaydeder (biçim korunur). */
export async function editParagraph(docId: string, p: number, newText: string) {
  const doc = (await db.getDocument(docId))!, texts = await readTexts(doc.stored_path);
  if (p < 0 || p >= texts.length) throw new Error("Geçersiz paragraf");
  const old = texts[p];
  newText = newText.replace(/\r\n/g, "\n");
  if (newText === previewParagraph(old, (await db.listFindings(docId)).filter((f) => f.paragraph === p))) return null;
  if (newText === old) { await db.deleteFindingsInRange(docId, p, 0, old.length); return null; }
  const [os, oe, ns, ne] = wordDiff(old, newText);
  await db.deleteFindingsInRange(docId, p, os, oe);
  return db.addFinding(docId, p, os, oe, old.slice(os, oe), [], { category: "editör", reason: "Editör tarafından senaryoda doğrudan düzenlendi.",
    severity: "dusuk", source: "manuel", status: "kabul", chosen: newText.slice(ns, ne) });
}

export async function exportDoc(docId: string, tracked = false, dest?: string) {
  const doc = await db.getDocument(docId);
  if (!doc) throw new Error("Belge bulunamadı");
  const stem = path.parse(doc.name).name.replace(/[<>:"/\\|?*]+/g, "_");
  const out = dest ?? path.join(DATA_DIR, "exports", `${stem}${tracked ? "_revize_izlenen" : "_revize"}.docx`);
  const r = await applyChanges(doc.stored_path, out, await db.listFindings(docId, "kabul"), tracked, loadConfig().author || "Senaryo Asistanı");
  return { ...r, path: out, pending: (await db.listFindings(docId, "bekliyor")).length };
}

/** Yere yazılmış bir notu OpenAI'ya (fikir modeli) uygulatır: o kısım için önerili bir bulgu oluşturur. */
export async function applyNote(noteId: string) {
  const note = await db.getNote(noteId);
  if (!note || note.scope !== "yer" || !note.doc_id) throw new Error("Yalnızca senaryoda bir yere yazılmış notlar uygulanabilir");
  if (!aiReady()) throw new Error("OpenAI bağlantısı yok. Ayarlar'dan OpenAI API anahtarı ekleyin ya da notu MCP bağlayıcısından uygulatın.");
  const doc = (await db.getDocument(note.doc_id))!, texts = await readTexts(doc.stored_path), para = texts[note.paragraph] ?? "";
  const ctx = texts.slice(Math.max(0, note.paragraph - 4), note.paragraph + 5).filter((t) => t.trim()).join("\n");
  const r = await aiApplyNote(note, para, ctx);
  if (!r) throw new Error("OpenAI bir öneri üretemedi");
  let s = r.quote ? para.indexOf(r.quote) : -1, e = s + r.quote.length;
  if (s < 0) { s = note.start ?? 0; e = note.end ?? para.length; } // bulunamazsa editörün seçtiği aralık
  const f = await db.addFinding(doc.id, note.paragraph, s, e, para.slice(s, e), r.suggestions,
    { category: "editör notu", reason: `Not: ${note.text}${r.reason ? " — " + r.reason : ""}`, severity: "orta", source: "not" });
  await db.updateNote(note.id, { status: "uygulandi" });
  return f;
}
