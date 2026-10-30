// Generates Kinly's built-in profile avatars into src/assets/avatars/ from DiceBear styles
// (https://www.dicebear.com). The SVGs are committed, so the app never calls an avatar API.
// Re-run after changing the seed lists:  node scripts/generate-avatars.mjs
//
// Styles (both by Lisa Wischofsky; licences recorded in THIRD_PARTY_NOTICES.md and inside each SVG):
//   adventurer  CC BY 4.0
//   lorelei     CC0 1.0
import { createAvatar } from "@dicebear/core";
import { adventurer, lorelei } from "@dicebear/collection";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../src/assets/avatars/", import.meta.url));
const BACKGROUNDS = ["b6e3f4", "c0aede", "d1d4f9", "ffd5dc", "ffdfbf", "c1f0c1", "fde68a", "a7f3d0"];

// Seeds `kinly-<style>-<n>`, picked for distinct, friendly faces. Keys are what profiles store
// (^[a-z0-9-]{1,24}$), so a chosen number must never be reused for a different face.
const SETS = [
  { style: adventurer, name: "adventurer", picks: [0, 1, 2, 3, 4, 5, 7, 8, 11, 12, 14, 16, 18, 19, 21, 26, 30, 33, 36, 39] },
  { style: lorelei, name: "lorelei", picks: [0, 3, 7, 8, 9, 12, 13, 17, 19, 24, 27, 28, 29, 35, 38, 39] },
];

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.endsWith(".svg")) rmSync(OUT + f);
let n = 0;
for (const { style, name, picks } of SETS) {
  for (const i of picks) {
    const svg = createAvatar(style, { seed: `kinly-${name}-${i}`, backgroundColor: BACKGROUNDS }).toString();
    writeFileSync(`${OUT}${name}-${i}.svg`, svg + "\n");
    n++;
  }
}
console.log(`wrote ${n} avatars to ${OUT}`);
