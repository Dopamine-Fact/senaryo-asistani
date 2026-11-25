// Ortam, veri klasörü ve kullanıcı ayarları.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// .env (proje kökünde) — bağımlılıksız küçük okuyucu; gerçek ortam değişkenleri önceliklidir
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export const DATA_DIR = process.env.SENARYO_ASISTANI_DATA || path.join(os.homedir(), ".senaryo-asistani");
for (const sub of ["belgeler", "bellek", "exports"]) fs.mkdirSync(path.join(DATA_DIR, sub), { recursive: true });
const CONFIG_PATH = path.join(DATA_DIR, "ayarlar.json");

export const PORT = Number(process.env.PORT || 8765);
export const HOST = process.env.HOST || "127.0.0.1";

// model_revizyon: senaryo incelemesi; model_fikir: yeni öneri ve not uygulama (fikir geliştirme)
// OpenAI API anahtarı burada değil, ortam değişkeninde (.env → OPENAI_API_KEY) tutulur.
export type Config = { model_revizyon: string; model_fikir: string; ai_enabled: boolean; auto_learn: boolean; author: string };
export const DEFAULT_CONFIG: Config = {
  model_revizyon: "gpt-6.1-sol", model_fikir: "gpt-6.1-terra", ai_enabled: true, auto_learn: false, author: "Senaryo Asistanı",
};

export function loadConfig(): Config {
  let saved: any = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch {}
  // Yalnızca bilinen alanlar: eski sürümde ayarlara kaydedilmiş API anahtarı arayüze geri gönderilmesin
  return Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([k, v]) => [k, saved[k] ?? v])) as Config;
}

// Eski sürüm anahtarı Ayarlar sayfasından ayarlar.json'a yazıyordu; artık okunmuyor, .env'ye taşınmalı
try {
  const old = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if ((old.openai_key || old.api_key) && !process.env.OPENAI_API_KEY) {
    console.warn(`⚠ ${CONFIG_PATH} içinde eski bir OpenAI API anahtarı var ama artık kullanılmıyor. Anahtarı .env dosyasına OPENAI_API_KEY=... olarak ekleyin (sunucuda ortam değişkeni olarak).`);
  }
} catch {}

export function saveConfig(update: Partial<Config>): Config {
  const cfg = loadConfig();
  for (const k of Object.keys(DEFAULT_CONFIG) as (keyof Config)[]) {
    if (update[k] !== undefined) (cfg as any)[k] = update[k];
  }
  // Yalnızca bilinen alanlar yazılır: eski sürümden kalan Claude anahtarı (api_key) ilk kayıtta silinir
  const known = Object.fromEntries(Object.keys(DEFAULT_CONFIG).map((k) => [k, (cfg as any)[k]]));
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(known, null, 2), "utf8");
  return cfg;
}

export const now = () => {
  const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
