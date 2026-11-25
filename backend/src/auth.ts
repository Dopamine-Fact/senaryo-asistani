// Üyelik: .env'deki erişim anahtarıyla giriş; imzalı oturum çerezi; MCP bağlantı yolu.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

export const COOKIE = "sa_oturum";
export const MAX_AGE = 60 * 60 * 24 * 90; // 90 gün

// 512 karakter: `npm run anahtar` ile üretilen; 128 karakter: anahtar boşken sunucunun kendi ürettiği
export const validKey = (k: string) => /^([0-9a-f]{128}|[0-9a-f]{512})$/i.test(k);

export function accessKey(): string {
  const k = (process.env.SENARYO_ERISIM_ANAHTARI || "").trim();
  if (!validKey(k)) {
    throw new Error("SENARYO_ERISIM_ANAHTARI 128 ya da 512 onaltılık karakter değil. Boş bırakın (sunucu üretir) ya da `npm run anahtar` ile üretin.");
  }
  return k.toLowerCase();
}

/** Anahtar boşsa veri klasöründekini kullanır, o da yoksa 128 karakterlik yenisini üretip yazar; her iki durumda konsola basar. */
export function ensureKey() {
  if ((process.env.SENARYO_ERISIM_ANAHTARI || "").trim()) return accessKey();
  // Veri klasörüne yazılır ki her yeniden başlatmada/deploy'da anahtar (ve oturumlar) değişmesin
  const file = path.join(DATA_DIR, "erisim_anahtari");
  const saved = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
  const k = validKey(saved) ? saved : crypto.randomBytes(64).toString("hex");
  if (k !== saved) fs.writeFileSync(file, k + "\n", { encoding: "utf8", mode: 0o600 });
  process.env.SENARYO_ERISIM_ANAHTARI = k;
  console.log(`SENARYO_ERISIM_ANAHTARI boş; ${k === saved ? "kayıtlı" : "yeni üretilen"} anahtar kullanılıyor (${file}):\n${k}`);
  return k;
}

const hmac = (label: string, msg: string) => crypto.createHmac("sha256", accessKey()).update(label + ":" + msg).digest("hex");

/** Sabit süreli karşılaştırma (boşluk/satır sonu kopyalama hatalarına toleranslı). */
export function checkKey(given: string) {
  const a = Buffer.from(given.replace(/\s+/g, "").toLowerCase()), b = Buffer.from(accessKey());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function makeSession(name: string) {
  const payload = Buffer.from(`${name}|${Math.floor(Date.now() / 1000)}`).toString("base64url");
  return `${payload}.${hmac("oturum", payload).slice(0, 40)}`;
}

export function readSession(v?: string): string | null {
  if (!v || !v.includes(".")) return null;
  const [payload, sig] = v.split(".");
  const want = hmac("oturum", payload).slice(0, 40);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  const [name, ts] = Buffer.from(payload, "base64url").toString().split(/\|(?=\d+$)/);
  return name && Date.now() / 1000 - Number(ts) < MAX_AGE ? name : null;
}

/** Claude bağlayıcısının gizli yolu (anahtardan türetilir; anahtar değişirse bu da değişir). */
export const mcpToken = () => hmac("mcp", "baglanti").slice(0, 32);

/** Anahtarın son 4 karakteri — hangi kurulumun anahtarının kullanıldığını ayırt etmek için (gizli değeri açığa çıkarmaz). */
export const keyHint = (k = accessKey()) => k.replace(/\s+/g, "").slice(-4).toLowerCase();
