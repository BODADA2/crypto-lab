// Scellement du code exécuté : npx tsx lab/exec/seal.ts [--check]
// À lancer par Hervé UNIQUEMENT après avoir relu le diff (git diff / git log -p) du code sous lab/.
// Écrit ~/.crypto-lab/exec.manifest.json ; l'exécuteur refuse le mode live si le code courant s'en écarte.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultCodeRoot, sealManifest, verifyIntegrity } from "./integrity.ts";

function main(): void {
  const check = process.argv.includes("--check");
  const codeRoot = defaultCodeRoot();
  if (check) {
    const r = verifyIntegrity({ codeRoot });
    console.log(JSON.stringify({ status: r.status, sealedAt: r.sealedAt ?? null, changed: r.changed, manifest: r.manifestPath }, null, 2));
    process.exit(r.status === "sealed" ? 0 : 2);
  }
  const before = verifyIntegrity({ codeRoot });
  const { manifestPath, manifest } = sealManifest({ codeRoot });
  console.log(`Code scellé : ${Object.keys(manifest.files).length} fichiers sous ${codeRoot}`);
  if (before.status === "mismatch") console.log(`Différences depuis le scellement précédent :\n  ${before.changed.join("\n  ")}`);
  console.log(`Manifeste : ${manifestPath}`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) main();
