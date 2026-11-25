// Başlatıcılar için: güncellemeden sonra paketler ya da arayüz eskiyse çıkış kodu 1 döner.
//   node guncel.mjs paketler        -> package-lock.json değiştiyse 1 (npm install gerekir)
//   node guncel.mjs arayuz          -> frontend kaynakları değiştiyse 1 (npm run build gerekir)
//   node guncel.mjs paketler|arayuz kaydet  -> kurulum/derleme bitti, damgayı yaz
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [what, save] = process.argv.slice(2);
const files = what === "paketler" ? ["package-lock.json"]
  : ["frontend/app", "frontend/lib", "frontend/package.json", "frontend/next.config.ts", "frontend/next.config.mjs"]
    .filter((p) => fs.existsSync(p))
    .flatMap((p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p, { recursive: true }).map((f) => path.join(p, String(f))) : [p])
    .filter((p) => fs.statSync(p).isFile()).sort();
const h = crypto.createHash("sha256");
for (const f of files) h.update(f.replaceAll("\\", "/")).update(fs.readFileSync(f));
const stamp = what === "paketler" ? "node_modules/.sa-paketler" : "frontend/out/.sa-arayuz";
const sum = h.digest("hex");
if (save) fs.writeFileSync(stamp, sum);
else process.exit(fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === sum ? 0 : 1);
