// Kinly's built-in profile avatars: DiceBear "Adventurer" (CC BY 4.0) and "Lorelei" (CC0 1.0)
// faces by Lisa Wischofsky, generated once by scripts/generate-avatars.mjs and bundled as SVG
// files, so nothing is fetched to show them. Keys are what the server stores (^[a-z0-9-]{1,24}$);
// keys of the earlier hand-drawn and emoji avatars map to one of these.

export type AvatarCategory = "adventurers" | "portraits";

/** Picker groups, in order. */
export const AVATAR_CATEGORIES: { id: AvatarCategory; label: string }[] = [
  { id: "adventurers", label: "Adventurers" },
  { id: "portraits", label: "Portraits" },
];

export type Art = { key: string; label: string; src: string; cat: AvatarCategory };

const FILES = import.meta.glob<string>("../assets/avatars/*.svg", { eager: true, query: "?url", import: "default" });
const CATEGORY_OF: Record<string, AvatarCategory> = { adventurer: "adventurers", lorelei: "portraits" };
const LABEL_OF: Record<string, string> = { adventurer: "Adventurer", lorelei: "Portrait" };

/** Every built-in avatar, grouped by category, in seed order within a group. */
export const AVATAR_ART: Art[] = Object.entries(FILES)
  .map(([path, src]) => {
    const key = path.split("/").pop()!.replace(/\.svg$/, "");
    const [style, n] = key.split("-");
    return { key, src, style, n: Number(n), cat: CATEGORY_OF[style] };
  })
  .filter((a) => a.cat)
  .sort((a, b) => AVATAR_CATEGORIES.findIndex((c) => c.id === a.cat) - AVATAR_CATEGORIES.findIndex((c) => c.id === b.cat) || a.n - b.n)
  .map(({ key, src, style, cat }, i, all) => ({ key, src, cat, label: `${LABEL_OF[style]} ${all.slice(0, i + 1).filter((x) => x.cat === cat).length}` }));

export const avatarCategory = (a: Art): AvatarCategory => a.cat;

/**
 * Keys of the earlier avatars (hand-drawn characters, and the emoji set before them) → the avatar
 * that replaces them, so existing profiles keep a picture without any server change.
 */
const OLD_KEYS = [
  "sunny", "fox", "owl", "robot", "cat", "bear", "alien", "frog", "ghost", "panda", "octo", "monster", "bunny", "penguin",
  "lion", "koala", "tiger", "piglet", "pup", "raccoon", "chick", "axolotl", "bolt", "tvbot", "astro", "saturn", "rocket",
  "ufo", "moonbeam", "dino", "dragon", "wizard", "ninja", "yeti", "slime", "pumpkin", "blob", "prism", "pixel", "bloom",
  "split", "cube", "sparkle", "ocean", "whale", "dolphin", "octopus", "turtle", "crab", "fish", "shell", "coral", "star",
  "moon", "sun",
];
export const LEGACY_AVATARS: Record<string, string> = Object.fromEntries(OLD_KEYS.map((k, i) => [k, AVATAR_ART[i % AVATAR_ART.length].key]));

export const DEFAULT_AVATAR = AVATAR_ART[0].key;

/** The avatar for a stored key (old keys included); unknown keys get the default. */
export function avatarArt(key: string): Art {
  const k = LEGACY_AVATARS[key] ?? key;
  return AVATAR_ART.find((a) => a.key === k) ?? AVATAR_ART[0];
}

export function AvatarImage({ avatarKey }: { avatarKey: string }) {
  const a = avatarArt(avatarKey);
  return <img className="avatar-img" src={a.src} alt={a.label} width={100} height={100} decoding="async" draggable={false} />;
}
