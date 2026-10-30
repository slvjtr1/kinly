// Kinly's built-in profile avatars: original character faces drawn as inline SVG (100×100).
// Keys are what the server stores (^[a-z0-9-]{1,24}$). Old emoji keys map to a new character.
import type { ReactElement } from "react";

const INK = "#1b1530";

function Eye({ x, y, r = 7, look = 0 }: { x: number; y: number; r?: number; look?: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill="#fff" />
      <circle cx={x + look} cy={y + r * 0.12} r={r * 0.56} fill={INK} />
      <circle cx={x + look + r * 0.22} cy={y - r * 0.18} r={r * 0.2} fill="#fff" />
    </g>
  );
}

const Cheeks = ({ y = 64, dx = 22, color = "#ff7aa8" }: { y?: number; dx?: number; color?: string }) => (
  <g opacity={0.55} fill={color}>
    <ellipse cx={50 - dx} cy={y} rx={6} ry={4} />
    <ellipse cx={50 + dx} cy={y} rx={6} ry={4} />
  </g>
);

/** A friendly curved mouth from (50-w, y) to (50+w, y). */
const Smile = ({ y = 66, w = 9, d = 6, s = 3 }: { y?: number; w?: number; d?: number; s?: number }) => (
  <path d={`M${50 - w} ${y} Q50 ${y + d * 2} ${50 + w} ${y}`} fill="none" stroke={INK} strokeWidth={s} strokeLinecap="round" />
);

/** Closed, happy eye: an upward arc. */
const HappyEye = ({ x, y, w = 6, color = INK }: { x: number; y: number; w?: number; color?: string }) => (
  <path d={`M${x - w} ${y + 2} Q${x} ${y - w} ${x + w} ${y + 2}`} fill="none" stroke={color} strokeWidth={3.4} strokeLinecap="round" />
);

const Stars = ({ pts }: { pts: [number, number, number][] }) => (
  <g fill="#fff" opacity={0.75}>
    {pts.map(([x, y, r]) => <circle key={`${x}-${y}`} cx={x} cy={y} r={r} />)}
  </g>
);

export type AvatarCategory = "classics" | "animals" | "space" | "characters" | "abstract";

/** Picker groups, in order. */
export const AVATAR_CATEGORIES: { id: AvatarCategory; label: string }[] = [
  { id: "classics", label: "Classics" },
  { id: "animals", label: "Animals" },
  { id: "space", label: "Robots & Space" },
  { id: "characters", label: "Characters" },
  { id: "abstract", label: "Abstract" },
];

type Art = { key: string; label: string; bg: [string, string]; draw: () => ReactElement; cat?: AvatarCategory };

/** The group an avatar is listed under in the picker (the original twelve are "classics"). */
export const avatarCategory = (a: Art): AvatarCategory => a.cat ?? "classics";

export const AVATAR_ART: Art[] = [
  {
    key: "sunny",
    label: "Sunny",
    bg: ["#ff8a3d", "#ffcf4a"],
    draw: () => (
      <>
        <g fill="#fff3b0" opacity={0.9}>
          {Array.from({ length: 10 }, (_, i) => (
            <path key={i} d="M50 6 L55 20 L45 20 Z" transform={`rotate(${i * 36} 50 54)`} />
          ))}
        </g>
        <circle cx={50} cy={54} r={30} fill="#ffd93b" stroke="#f7a51c" strokeWidth={3} />
        <Eye x={39} y={48} r={6.5} />
        <Eye x={61} y={48} r={6.5} />
        <Cheeks y={62} dx={19} />
        <path d="M38 63 Q50 76 62 63" fill="none" stroke={INK} strokeWidth={4} strokeLinecap="round" />
      </>
    ),
  },
  {
    key: "fox",
    label: "Fox",
    bg: ["#0f8f8a", "#3fd1b8"],
    draw: () => (
      <>
        <path d="M20 22 L40 40 L26 52 Z" fill="#ff7a2f" />
        <path d="M80 22 L60 40 L74 52 Z" fill="#ff7a2f" />
        <path d="M24 30 L34 41 L28 46 Z" fill="#ffd9c2" />
        <path d="M76 30 L66 41 L72 46 Z" fill="#ffd9c2" />
        <path d="M18 46 Q50 18 82 46 Q78 74 50 86 Q22 74 18 46 Z" fill="#ff7a2f" />
        <path d="M30 60 Q50 54 70 60 Q64 80 50 86 Q36 80 30 60 Z" fill="#fff4ea" />
        <Eye x={38} y={52} r={6} look={1} />
        <Eye x={62} y={52} r={6} look={1} />
        <ellipse cx={50} cy={66} rx={5} ry={3.6} fill={INK} />
        <path d="M44 72 Q50 77 56 72" fill="none" stroke={INK} strokeWidth={2.6} strokeLinecap="round" />
      </>
    ),
  },
  {
    key: "owl",
    label: "Owl",
    bg: ["#4b2a8a", "#8f63e8"],
    draw: () => (
      <>
        <path d="M22 26 L34 36 L26 44 Z" fill="#8a5a2b" />
        <path d="M78 26 L66 36 L74 44 Z" fill="#8a5a2b" />
        <ellipse cx={50} cy={58} rx={32} ry={30} fill="#b57a3e" />
        <path d="M34 76 Q50 90 66 76 Q50 70 34 76 Z" fill="#e9c08a" />
        <circle cx={37} cy={52} r={13} fill="#ffe9c4" />
        <circle cx={63} cy={52} r={13} fill="#ffe9c4" />
        <Eye x={37} y={52} r={8} />
        <Eye x={63} y={52} r={8} />
        <path d="M45 62 L55 62 L50 71 Z" fill="#ffb12b" />
      </>
    ),
  },
  {
    key: "robot",
    label: "Robot",
    bg: ["#1360c2", "#3fb3ff"],
    draw: () => (
      <>
        <line x1={50} y1={14} x2={50} y2={26} stroke="#cfd8e6" strokeWidth={4} />
        <circle cx={50} cy={12} r={5} fill="#ff5470" />
        <rect x={20} y={26} width={60} height={54} rx={14} fill="#e3e9f2" />
        <rect x={13} y={44} width={8} height={18} rx={3} fill="#b9c4d6" />
        <rect x={79} y={44} width={8} height={18} rx={3} fill="#b9c4d6" />
        <rect x={27} y={36} width={46} height={26} rx={10} fill="#1e2a44" />
        <circle cx={39} cy={49} r={6} fill="#5ff0ff" />
        <circle cx={61} cy={49} r={6} fill="#5ff0ff" />
        <circle cx={41} cy={47} r={2} fill="#fff" />
        <circle cx={63} cy={47} r={2} fill="#fff" />
        <rect x={36} y={68} width={28} height={6} rx={3} fill="#9aa8bd" />
        <g fill="#e3e9f2">
          <rect x={40} y={68} width={3} height={6} />
          <rect x={48} y={68} width={3} height={6} />
          <rect x={56} y={68} width={3} height={6} />
        </g>
      </>
    ),
  },
  {
    key: "cat",
    label: "Cat",
    bg: ["#e0457b", "#ff9ec4"],
    draw: () => (
      <>
        <path d="M20 20 L42 34 L22 50 Z" fill="#2b2240" />
        <path d="M80 20 L58 34 L78 50 Z" fill="#2b2240" />
        <path d="M24 28 L35 35 L26 43 Z" fill="#ff8fb5" />
        <path d="M76 28 L65 35 L74 43 Z" fill="#ff8fb5" />
        <ellipse cx={50} cy={58} rx={32} ry={28} fill="#2b2240" />
        <ellipse cx={38} cy={54} rx={7} ry={8} fill="#c8ff5a" />
        <ellipse cx={62} cy={54} rx={7} ry={8} fill="#c8ff5a" />
        <ellipse cx={38} cy={55} rx={2.6} ry={6} fill={INK} />
        <ellipse cx={62} cy={55} rx={2.6} ry={6} fill={INK} />
        <path d="M46 65 L54 65 L50 69 Z" fill="#ff8fb5" />
        <path d="M44 72 Q47 75 50 71 Q53 75 56 72" fill="none" stroke="#ff8fb5" strokeWidth={2.4} strokeLinecap="round" />
        <g stroke="#fff" strokeWidth={1.8} strokeLinecap="round" opacity={0.8}>
          <line x1={28} y1={66} x2={14} y2={63} />
          <line x1={28} y1={70} x2={14} y2={72} />
          <line x1={72} y1={66} x2={86} y2={63} />
          <line x1={72} y1={70} x2={86} y2={72} />
        </g>
      </>
    ),
  },
  {
    key: "bear",
    label: "Bear",
    bg: ["#2f8f3e", "#7bd96b"],
    draw: () => (
      <>
        <circle cx={26} cy={30} r={12} fill="#8b5a34" />
        <circle cx={74} cy={30} r={12} fill="#8b5a34" />
        <circle cx={26} cy={30} r={6} fill="#d9a06b" />
        <circle cx={74} cy={30} r={6} fill="#d9a06b" />
        <circle cx={50} cy={56} r={32} fill="#a46a3d" />
        <ellipse cx={50} cy={68} rx={16} ry={12} fill="#f1d1a8" />
        <Eye x={38} y={50} r={5.5} />
        <Eye x={62} y={50} r={5.5} />
        <ellipse cx={50} cy={63} rx={6} ry={4.4} fill={INK} />
        <path d="M44 71 Q50 76 56 71" fill="none" stroke={INK} strokeWidth={2.6} strokeLinecap="round" />
      </>
    ),
  },
  {
    key: "alien",
    label: "Alien",
    bg: ["#141b3d", "#3a3f8f"],
    draw: () => (
      <>
        <g fill="#fff" opacity={0.7}>
          <circle cx={16} cy={18} r={1.6} />
          <circle cx={84} cy={24} r={1.2} />
          <circle cx={80} cy={84} r={1.4} />
          <circle cx={14} cy={78} r={1} />
        </g>
        <line x1={36} y1={30} x2={28} y2={14} stroke="#7cf27a" strokeWidth={3} strokeLinecap="round" />
        <line x1={64} y1={30} x2={72} y2={14} stroke="#7cf27a" strokeWidth={3} strokeLinecap="round" />
        <circle cx={28} cy={13} r={4.5} fill="#ffe74a" />
        <circle cx={72} cy={13} r={4.5} fill="#ffe74a" />
        <path d="M18 50 Q18 24 50 24 Q82 24 82 50 Q82 80 50 86 Q18 80 18 50 Z" fill="#7cf27a" />
        <ellipse cx={36} cy={52} rx={10} ry={12} fill={INK} transform="rotate(-18 36 52)" />
        <ellipse cx={64} cy={52} rx={10} ry={12} fill={INK} transform="rotate(18 64 52)" />
        <circle cx={39} cy={47} r={3} fill="#fff" />
        <circle cx={67} cy={47} r={3} fill="#fff" />
        <path d="M42 72 Q50 78 58 72" fill="none" stroke={INK} strokeWidth={3} strokeLinecap="round" />
      </>
    ),
  },
  {
    key: "frog",
    label: "Frog",
    bg: ["#e8a812", "#ffe066"],
    draw: () => (
      <>
        <circle cx={32} cy={34} r={14} fill="#3cbf5a" />
        <circle cx={68} cy={34} r={14} fill="#3cbf5a" />
        <path d="M14 60 Q14 36 50 38 Q86 36 86 60 Q86 84 50 86 Q14 84 14 60 Z" fill="#3cbf5a" />
        <Eye x={32} y={33} r={9} look={1} />
        <Eye x={68} y={33} r={9} look={-1} />
        <Cheeks y={64} dx={26} color="#ff6f91" />
        <path d="M30 62 Q50 80 70 62" fill="#1f6b33" />
        <path d="M40 70 Q50 76 60 70 Q50 80 40 70 Z" fill="#ff7a8a" />
      </>
    ),
  },
  {
    key: "ghost",
    label: "Ghost",
    bg: ["#6c3bd1", "#c38cff"],
    draw: () => (
      <>
        <path d="M24 86 L24 46 Q24 18 50 18 Q76 18 76 46 L76 86 L67 78 L58 86 L50 78 L42 86 L33 78 Z" fill="#fbf7ff" />
        <ellipse cx={40} cy={46} rx={5} ry={7} fill={INK} />
        <ellipse cx={60} cy={46} rx={5} ry={7} fill={INK} />
        <circle cx={41.5} cy={43} r={1.8} fill="#fff" />
        <circle cx={61.5} cy={43} r={1.8} fill="#fff" />
        <Cheeks y={57} dx={17} color="#ff9ccd" />
        <ellipse cx={50} cy={61} rx={5} ry={6} fill={INK} />
      </>
    ),
  },
  {
    key: "panda",
    label: "Panda",
    bg: ["#d63a3a", "#ff7a59"],
    draw: () => (
      <>
        <circle cx={25} cy={28} r={12} fill={INK} />
        <circle cx={75} cy={28} r={12} fill={INK} />
        <circle cx={50} cy={56} r={33} fill="#fdfdfd" />
        <ellipse cx={36} cy={52} rx={10} ry={12} fill={INK} transform="rotate(28 36 52)" />
        <ellipse cx={64} cy={52} rx={10} ry={12} fill={INK} transform="rotate(-28 64 52)" />
        <circle cx={37} cy={52} r={4.6} fill="#fff" />
        <circle cx={63} cy={52} r={4.6} fill="#fff" />
        <circle cx={38} cy={53} r={2.6} fill={INK} />
        <circle cx={62} cy={53} r={2.6} fill={INK} />
        <ellipse cx={50} cy={66} rx={5.5} ry={4} fill={INK} />
        <path d="M44 73 Q50 78 56 73" fill="none" stroke={INK} strokeWidth={2.6} strokeLinecap="round" />
        <Cheeks y={70} dx={21} />
      </>
    ),
  },
  {
    key: "octo",
    label: "Octo",
    bg: ["#0b5e8f", "#1fb6e8"],
    draw: () => (
      <>
        <g fill="#ff6f9f">
          {[22, 34, 46, 58, 70].map((x, i) => (
            <path key={x} d={`M${x} 64 Q${x - 4} ${80 + (i % 2) * 6} ${x + 4} 88 Q${x + 10} 80 ${x + 8} 64 Z`} />
          ))}
        </g>
        <ellipse cx={50} cy={46} rx={30} ry={28} fill="#ff6f9f" />
        <g fill="#ffb3cd" opacity={0.8}>
          <circle cx={36} cy={28} r={3.5} />
          <circle cx={62} cy={26} r={2.6} />
          <circle cx={70} cy={36} r={2} />
        </g>
        <Eye x={39} y={48} r={7} />
        <Eye x={61} y={48} r={7} />
        <path d="M42 61 Q50 67 58 61" fill="none" stroke={INK} strokeWidth={3} strokeLinecap="round" />
      </>
    ),
  },
  {
    key: "monster",
    label: "Fuzzy",
    bg: ["#f2611d", "#ffa14a"],
    draw: () => (
      <>
        <path d="M30 26 Q26 12 34 10 Q36 20 40 24 Z" fill="#fff5d6" />
        <path d="M70 26 Q74 12 66 10 Q64 20 60 24 Z" fill="#fff5d6" />
        <path
          d="M50 18 L56 24 L64 20 L67 28 L76 28 L76 37 L84 42 L79 50 L84 58 L77 63 L79 72 L70 74 L67 82 L58 80 L50 86 L42 80 L33 82 L30 74 L21 72 L23 63 L16 58 L21 50 L16 42 L24 37 L24 28 L33 28 L36 20 L44 24 Z"
          fill="#3b7bff"
        />
        <Eye x={50} y={46} r={13} look={1} />
        <path d="M34 64 Q50 78 66 64 Z" fill={INK} />
        <path d="M40 65 L43 70 L46 66 Z M54 66 L57 70 L60 65 Z" fill="#fff" />
      </>
    ),
  },

  // ----------------------------------------------------------------------------------- Animals
  {
    key: "bunny",
    label: "Bunny",
    cat: "animals",
    bg: ["#1f8f86", "#7fe0c8"],
    draw: () => (
      <>
        <ellipse cx={37} cy={26} rx={8} ry={20} fill="#f6f2ff" transform="rotate(-10 37 26)" />
        <ellipse cx={63} cy={26} rx={8} ry={20} fill="#f6f2ff" transform="rotate(10 63 26)" />
        <ellipse cx={37} cy={27} rx={3.6} ry={14} fill="#ffa8c8" transform="rotate(-10 37 27)" />
        <ellipse cx={63} cy={27} rx={3.6} ry={14} fill="#ffa8c8" transform="rotate(10 63 27)" />
        <circle cx={50} cy={62} r={27} fill="#f6f2ff" />
        <Eye x={40} y={58} r={5.5} />
        <Eye x={60} y={58} r={5.5} />
        <Cheeks y={68} dx={19} />
        <path d="M46 66 L54 66 L50 70 Z" fill="#ff7aa8" />
        <path d="M44 72 Q47 75 50 71 Q53 75 56 72" fill="none" stroke={INK} strokeWidth={2.4} strokeLinecap="round" />
        <rect x={47} y={73} width={6} height={6} rx={1.5} fill="#fff" stroke={INK} strokeWidth={1.4} />
      </>
    ),
  },
  {
    key: "penguin",
    label: "Penguin",
    cat: "animals",
    bg: ["#1c4f8c", "#5aaeea"],
    draw: () => (
      <>
        <ellipse cx={50} cy={56} rx={31} ry={33} fill="#1f2433" />
        <circle cx={40} cy={54} r={13} fill="#fff" />
        <circle cx={60} cy={54} r={13} fill="#fff" />
        <ellipse cx={50} cy={68} rx={19} ry={15} fill="#fff" />
        <Eye x={41} y={52} r={5} look={1} />
        <Eye x={59} y={52} r={5} look={-1} />
        <Cheeks y={64} dx={17} />
        <path d="M43 61 L57 61 L50 70 Z" fill="#ffa62b" stroke="#e8861a" strokeWidth={1.5} strokeLinejoin="round" />
      </>
    ),
  },
  {
    key: "lion",
    label: "Lion",
    cat: "animals",
    bg: ["#6d35d6", "#b98cff"],
    draw: () => (
      <>
        <g fill="#c2581a">
          {Array.from({ length: 12 }, (_, i) => {
            const a = (i * Math.PI) / 6;
            return <circle key={i} cx={50 + Math.cos(a) * 26} cy={55 + Math.sin(a) * 26} r={12} />;
          })}
        </g>
        <circle cx={50} cy={55} r={28} fill="#e0782a" />
        <circle cx={31} cy={36} r={7} fill="#ffc23d" />
        <circle cx={69} cy={36} r={7} fill="#ffc23d" />
        <circle cx={50} cy={57} r={23} fill="#ffc23d" />
        <Eye x={41} y={52} r={5} />
        <Eye x={59} y={52} r={5} />
        <ellipse cx={50} cy={66} rx={11} ry={8} fill="#ffe7a8" />
        <path d="M45 61 L55 61 L50 66 Z" fill={INK} />
        <path d="M44 69 Q47 72 50 68 Q53 72 56 69" fill="none" stroke={INK} strokeWidth={2.2} strokeLinecap="round" />
      </>
    ),
  },
  {
    key: "koala",
    label: "Koala",
    cat: "animals",
    bg: ["#0e7490", "#62dcf2"],
    draw: () => (
      <>
        <circle cx={24} cy={40} r={15} fill="#9aa3b1" />
        <circle cx={76} cy={40} r={15} fill="#9aa3b1" />
        <circle cx={24} cy={40} r={8} fill="#f6d3e2" />
        <circle cx={76} cy={40} r={8} fill="#f6d3e2" />
        <ellipse cx={50} cy={58} rx={28} ry={27} fill="#b3bbc8" />
        <Eye x={38} y={53} r={5} />
        <Eye x={62} y={53} r={5} />
        <ellipse cx={50} cy={64} rx={7.5} ry={10} fill="#2b2240" />
        <ellipse cx={47.5} cy={60} rx={2} ry={3} fill="#fff" opacity={0.5} />
        <Smile y={77} w={6} d={2.5} s={2.4} />
      </>
    ),
  },
  {
    key: "tiger",
    label: "Tiger",
    cat: "animals",
    bg: ["#15803d", "#5fe08a"],
    draw: () => (
      <>
        <circle cx={27} cy={31} r={10} fill="#f9781f" />
        <circle cx={73} cy={31} r={10} fill="#f9781f" />
        <circle cx={27} cy={31} r={5} fill="#fff0e2" />
        <circle cx={73} cy={31} r={5} fill="#fff0e2" />
        <circle cx={50} cy={56} r={30} fill="#f9781f" />
        <g fill={INK}>
          <path d="M44 26 L50 38 L56 26 Z" />
          <path d="M20 50 L33 53 L21 58 Z" />
          <path d="M80 50 L67 53 L79 58 Z" />
          <path d="M23 64 L33 64 L24 69 Z" />
          <path d="M77 64 L67 64 L76 69 Z" />
        </g>
        <ellipse cx={43} cy={68} rx={10} ry={8} fill="#fff6ec" />
        <ellipse cx={57} cy={68} rx={10} ry={8} fill="#fff6ec" />
        <Eye x={39} y={50} r={6} look={1} />
        <Eye x={61} y={50} r={6} look={-1} />
        <path d="M45 61 L55 61 L50 66 Z" fill="#ff7aa8" />
        <path d="M45 72 Q50 75 55 72" fill="none" stroke={INK} strokeWidth={2.2} strokeLinecap="round" />
      </>
    ),
  },
  {
    key: "piglet",
    label: "Piglet",
    cat: "animals",
    bg: ["#2f6fe0", "#93c2ff"],
    draw: () => (
      <>
        <path d="M22 22 L42 32 L26 46 Z" fill="#ff8fb5" />
        <path d="M78 22 L58 32 L74 46 Z" fill="#ff8fb5" />
        <circle cx={50} cy={57} r={30} fill="#ffb3cc" />
        <Eye x={38} y={50} r={5.5} />
        <Eye x={62} y={50} r={5.5} />
        <ellipse cx={50} cy={65} rx={13} ry={9} fill="#ff86ad" />
        <ellipse cx={45.5} cy={65} rx={2.6} ry={3.6} fill="#a33a63" />
        <ellipse cx={54.5} cy={65} rx={2.6} ry={3.6} fill="#a33a63" />
        <Cheeks y={66} dx={24} color="#ff5f92" />
        <Smile y={78} w={5} d={2} s={2.4} />
      </>
    ),
  },
  {
    key: "pup",
    label: "Pup",
    cat: "animals",
    bg: ["#e8b10f", "#ffe680"],
    draw: () => (
      <>
        <ellipse cx={25} cy={52} rx={10} ry={21} fill="#7a4628" transform="rotate(18 25 52)" />
        <ellipse cx={75} cy={52} rx={10} ry={21} fill="#7a4628" transform="rotate(-18 75 52)" />
        <ellipse cx={50} cy={55} rx={26} ry={29} fill="#e5ac72" />
        <ellipse cx={61} cy={47} rx={9} ry={10} fill="#c9864d" />
        <ellipse cx={50} cy={69} rx={14} ry={11} fill="#fff1de" />
        <Eye x={40} y={48} r={5} />
        <Eye x={61} y={48} r={5} />
        <ellipse cx={50} cy={63} rx={6} ry={4.5} fill={INK} />
        <path d="M44 70 Q50 74 56 70" fill="none" stroke={INK} strokeWidth={2.4} strokeLinecap="round" />
        <path d="M47 72 Q47 81 51 81 Q55 81 54 72 Z" fill="#ff6f8f" />
      </>
    ),
  },
  {
    key: "raccoon",
    label: "Raccoon",
    cat: "animals",
    bg: ["#8b2fd6", "#e07cf2"],
    draw: () => (
      <>
        <path d="M20 22 L40 34 L24 48 Z" fill="#6b7280" />
        <path d="M80 22 L60 34 L76 48 Z" fill="#6b7280" />
        <path d="M25 30 L35 36 L28 42 Z" fill="#f3f4f6" />
        <path d="M75 30 L65 36 L72 42 Z" fill="#f3f4f6" />
        <ellipse cx={50} cy={58} rx={32} ry={27} fill="#a3aab6" />
        <path d="M50 30 Q56 40 50 50 Q44 40 50 30 Z" fill="#6b7280" />
        <ellipse cx={37} cy={55} rx={13} ry={8.5} fill="#2b2240" transform="rotate(12 37 55)" />
        <ellipse cx={63} cy={55} rx={13} ry={8.5} fill="#2b2240" transform="rotate(-12 63 55)" />
        <Eye x={38} y={54} r={4.8} />
        <Eye x={62} y={54} r={4.8} />
        <ellipse cx={50} cy={70} rx={13} ry={9} fill="#f3f4f6" />
        <ellipse cx={50} cy={66} rx={4.5} ry={3.4} fill={INK} />
        <path d="M45 72 Q50 76 55 72" fill="none" stroke={INK} strokeWidth={2.2} strokeLinecap="round" />
      </>
    ),
  },
  {
    key: "chick",
    label: "Chick",
    cat: "animals",
    bg: ["#e0458f", "#ffa8d2"],
    draw: () => (
      <>
        <path d="M46 26 Q44 14 50 12 Q50 20 53 24 Q56 16 61 18 Q56 22 55 28 Z" fill="#ffc21a" />
        <circle cx={50} cy={58} r={30} fill="#ffd93b" />
        <path d="M22 62 Q14 52 22 46 Q26 56 30 60 Z" fill="#ffc21a" />
        <path d="M78 62 Q86 52 78 46 Q74 56 70 60 Z" fill="#ffc21a" />
        <Eye x={40} y={52} r={6} />
        <Eye x={60} y={52} r={6} />
        <Cheeks y={64} dx={20} />
        <path d="M43 62 Q50 58 57 62 L50 66 Z" fill="#ff8a2b" />
        <path d="M44 63 L56 63 Q50 72 44 63 Z" fill="#f2711c" />
      </>
    ),
  },
  {
    key: "axolotl",
    label: "Axolotl",
    cat: "animals",
    bg: ["#4338ca", "#8b93ff"],
    draw: () => (
      <>
        <g stroke="#ff7fae" strokeWidth={4} strokeLinecap="round">
          <line x1={22} y1={46} x2={8} y2={36} />
          <line x1={20} y1={56} x2={5} y2={56} />
          <line x1={22} y1={66} x2={8} y2={76} />
          <line x1={78} y1={46} x2={92} y2={36} />
          <line x1={80} y1={56} x2={95} y2={56} />
          <line x1={78} y1={66} x2={92} y2={76} />
        </g>
        <g fill="#ff7fae">
          <circle cx={8} cy={36} r={4} />
          <circle cx={5} cy={56} r={4} />
          <circle cx={8} cy={76} r={4} />
          <circle cx={92} cy={36} r={4} />
          <circle cx={95} cy={56} r={4} />
          <circle cx={92} cy={76} r={4} />
        </g>
        <ellipse cx={50} cy={58} rx={31} ry={25} fill="#ffc6dc" />
        <Eye x={36} y={53} r={5} />
        <Eye x={64} y={53} r={5} />
        <Cheeks y={64} dx={21} />
        <path d="M36 64 Q50 76 64 64" fill="none" stroke={INK} strokeWidth={3} strokeLinecap="round" />
      </>
    ),
  },

  // --------------------------------------------------------------------------- Robots & Space
  {
    key: "bolt",
    label: "Bolt",
    cat: "space",
    bg: ["#0f766e", "#33d6c0"],
    draw: () => (
      <>
        <path d="M52 6 L44 18 L50 18 L46 28 L56 15 L50 15 Z" fill="#ffe14a" stroke="#e8b10f" strokeWidth={1.2} strokeLinejoin="round" />
        <circle cx={18} cy={56} r={6} fill="#94a3b8" />
        <circle cx={82} cy={56} r={6} fill="#94a3b8" />
        <circle cx={50} cy={57} r={31} fill="#eef2f7" />
        <rect x={27} y={42} width={46} height={24} rx={12} fill="#1e293b" />
        <HappyEye x={39} y={55} w={6} color="#5ff0ff" />
        <HappyEye x={61} y={55} w={6} color="#5ff0ff" />
        <g fill="#94a3b8">
          <circle cx={42} cy={76} r={2} />
          <circle cx={50} cy={77} r={2} />
          <circle cx={58} cy={76} r={2} />
        </g>
      </>
    ),
  },
  {
    key: "tvbot",
    label: "Telly",
    cat: "space",
    bg: ["#be123c", "#ff7d93"],
    draw: () => (
      <>
        <g stroke="#2b2240" strokeWidth={3} strokeLinecap="round">
          <line x1={50} y1={28} x2={36} y2={12} />
          <line x1={50} y1={28} x2={64} y2={12} />
        </g>
        <circle cx={36} cy={12} r={3.5} fill="#ffe14a" />
        <circle cx={64} cy={12} r={3.5} fill="#ffe14a" />
        <rect x={18} y={28} width={64} height={54} rx={12} fill="#ffe08a" />
        <rect x={25} y={35} width={42} height={36} rx={8} fill="#1e293b" />
        <rect x={32} y={44} width={8} height={8} rx={1.5} fill="#34f0a0" />
        <rect x={52} y={44} width={8} height={8} rx={1.5} fill="#34f0a0" />
        <path d="M36 60 L40 64 L52 64 L56 60" fill="none" stroke="#34f0a0" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={74} cy={44} r={3.5} fill="#e05a2b" />
        <circle cx={74} cy={56} r={3.5} fill="#2b7bff" />
        <rect x={70} y={64} width={8} height={2.5} rx={1} fill="#b98a2b" />
      </>
    ),
  },
  {
    key: "astro",
    label: "Astro",
    cat: "space",
    bg: ["#0b1026", "#3b3a9a"],
    draw: () => (
      <>
        <Stars pts={[[14, 16, 1.6], [86, 20, 1.2], [84, 86, 1.4], [12, 84, 1]]} />
        <rect x={14} y={46} width={8} height={18} rx={3} fill="#cbd5e1" />
        <rect x={78} y={46} width={8} height={18} rx={3} fill="#cbd5e1" />
        <circle cx={50} cy={55} r={32} fill="#f1f5f9" />
        <ellipse cx={50} cy={55} rx={23} ry={19} fill="#ffd2ae" stroke="#2b3a8f" strokeWidth={4} />
        <Eye x={42} y={53} r={5} />
        <Eye x={58} y={53} r={5} />
        <Cheeks y={62} dx={13} />
        <Smile y={63} w={5} d={3} s={2.4} />
        <path d="M33 44 Q38 38 46 38" fill="none" stroke="#fff" strokeWidth={3} strokeLinecap="round" opacity={0.85} />
        <rect x={44} y={80} width={12} height={5} rx={2} fill="#ff5470" />
      </>
    ),
  },
  {
    key: "saturn",
    label: "Ringo",
    cat: "space",
    bg: ["#1e1b4b", "#7c3aed"],
    draw: () => (
      <>
        <Stars pts={[[16, 18, 1.4], [84, 14, 1.6], [86, 82, 1.2], [14, 80, 1.4]]} />
        <g transform="rotate(-16 50 54)">
          <ellipse cx={50} cy={54} rx={42} ry={10} fill="none" stroke="#ffd34a" strokeWidth={5} />
          <circle cx={50} cy={54} r={25} fill="#ff7096" />
          <path d="M30 40 Q50 34 70 40" fill="none" stroke="#ff9db6" strokeWidth={4} strokeLinecap="round" />
          {/* the front half of the ring, over the planet */}
          <path d="M8 54 A42 10 0 0 0 92 54" fill="none" stroke="#ffd34a" strokeWidth={5} />
        </g>
        <Eye x={42} y={48} r={4.6} />
        <Eye x={58} y={46} r={4.6} />
        <path d="M44 56 Q51 61 57 54" fill="none" stroke={INK} strokeWidth={2.6} strokeLinecap="round" />
      </>
    ),
  },
  {
    key: "rocket",
    label: "Rocket",
    cat: "space",
    bg: ["#0c4a6e", "#3cbdf6"],
    draw: () => (
      <>
        <Stars pts={[[16, 20, 1.4], [84, 26, 1.2], [18, 62, 1]]} />
        <path d="M42 74 Q50 98 58 74 Z" fill="#ffb12b" />
        <path d="M46 74 Q50 88 54 74 Z" fill="#ffe14a" />
        <path d="M34 54 L22 72 L36 70 Z" fill="#ff5470" />
        <path d="M66 54 L78 72 L64 70 Z" fill="#ff5470" />
        <path d="M50 8 Q70 26 67 74 L33 74 Q30 26 50 8 Z" fill="#f8fafc" />
        <path d="M50 8 Q60 16 64 26 L36 26 Q40 16 50 8 Z" fill="#ff5470" />
        <Eye x={43} y={46} r={5} />
        <Eye x={57} y={46} r={5} />
        <Cheeks y={55} dx={11} />
        <Smile y={56} w={5} d={3} s={2.4} />
        <rect x={40} y={66} width={20} height={4} rx={2} fill="#cbd5e1" />
      </>
    ),
  },
  {
    key: "ufo",
    label: "Saucer",
    cat: "space",
    bg: ["#172554", "#1aa3e0"],
    draw: () => (
      <>
        <path d="M38 64 L62 64 L80 94 L20 94 Z" fill="#fff59a" opacity={0.35} />
        <circle cx={50} cy={44} r={13} fill="#7cf27a" />
        <Eye x={45} y={42} r={4} />
        <Eye x={55} y={42} r={4} />
        <path d="M46 49 Q50 52 54 49" fill="none" stroke={INK} strokeWidth={2} strokeLinecap="round" />
        <path d="M32 50 A18 18 0 0 1 68 50 Z" fill="#bff3ff" opacity={0.45} />
        <path d="M32 50 A18 18 0 0 1 50 32" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" opacity={0.8} />
        <ellipse cx={50} cy={58} rx={38} ry={11} fill="#b6c2d4" />
        <ellipse cx={50} cy={54} rx={30} ry={6} fill="#e3e9f2" />
        <g fill="#ffe14a">
          {[22, 36, 50, 64, 78].map((x) => <circle key={x} cx={x} cy={x === 22 || x === 78 ? 59 : 62} r={3} />)}
        </g>
      </>
    ),
  },
  {
    key: "moonbeam",
    label: "Moonbeam",
    cat: "space",
    bg: ["#0f172a", "#3b4a6b"],
    draw: () => (
      <>
        <Stars pts={[[14, 16, 1.6], [86, 18, 1.4], [82, 84, 1.2], [18, 86, 1.4], [70, 10, 1]]} />
        <circle cx={50} cy={52} r={31} fill="#fff1c2" />
        <g fill="#f5d98a" opacity={0.8}>
          <circle cx={30} cy={40} r={5} />
          <circle cx={68} cy={34} r={3.5} />
          <circle cx={72} cy={66} r={4.5} />
        </g>
        <HappyEye x={40} y={50} w={6} />
        <HappyEye x={60} y={50} w={6} />
        <Cheeks y={60} dx={19} />
        <Smile y={62} w={7} d={4} s={2.8} />
      </>
    ),
  },

  // ------------------------------------------------------------------------------- Characters
  {
    key: "dino",
    label: "Dino",
    cat: "characters",
    bg: ["#e89a0c", "#ffe14a"],
    draw: () => (
      <>
        <g fill="#0f9d6a">
          <path d="M30 30 L36 16 L42 28 Z" />
          <path d="M42 24 L50 10 L56 24 Z" />
          <path d="M56 26 L64 14 L68 30 Z" />
        </g>
        <path d="M18 56 Q18 26 50 24 Q82 26 82 56 Q82 86 50 86 Q18 86 18 56 Z" fill="#3fd18e" />
        <ellipse cx={34} cy={40} rx={4} ry={3} fill="#2fb77a" />
        <ellipse cx={66} cy={38} rx={3} ry={2.4} fill="#2fb77a" />
        <Eye x={38} y={50} r={7} />
        <Eye x={62} y={50} r={7} />
        <path d="M30 64 Q50 82 70 64 Z" fill="#1f5a3e" />
        <path d="M33 65 L38 71 L43 66 Z M57 66 L62 71 L67 65 Z" fill="#fff" />
        <Cheeks y={62} dx={25} />
      </>
    ),
  },
  {
    key: "dragon",
    label: "Dragon",
    cat: "characters",
    bg: ["#991b1b", "#ff6b5c"],
    draw: () => (
      <>
        <path d="M30 32 Q20 16 28 6 Q32 20 40 28 Z" fill="#fff1d6" />
        <path d="M70 32 Q80 16 72 6 Q68 20 60 28 Z" fill="#fff1d6" />
        <path d="M14 46 L28 40 L26 54 Z" fill="#7c4ddb" />
        <path d="M86 46 L72 40 L74 54 Z" fill="#7c4ddb" />
        <ellipse cx={50} cy={54} rx={28} ry={28} fill="#9b6cff" />
        <ellipse cx={50} cy={70} rx={20} ry={13} fill="#c6a8ff" />
        <ellipse cx={44} cy={68} rx={2.4} ry={3} fill={INK} />
        <ellipse cx={56} cy={68} rx={2.4} ry={3} fill={INK} />
        <Eye x={39} y={48} r={6.5} look={1} />
        <Eye x={61} y={48} r={6.5} look={-1} />
        <path d="M42 76 Q50 80 58 76" fill="none" stroke={INK} strokeWidth={2.4} strokeLinecap="round" />
        <path d="M45 34 L50 28 L55 34 Z" fill="#ffd34a" />
      </>
    ),
  },
  {
    key: "wizard",
    label: "Wizard",
    cat: "characters",
    bg: ["#1e3a8a", "#6a6ff0"],
    draw: () => (
      <>
        <path d="M50 4 L72 44 L28 44 Z" fill="#8b4dff" />
        <path d="M50 18 L52 23 L57 23 L53 26 L55 31 L50 28 L45 31 L47 26 L43 23 L48 23 Z" fill="#ffe14a" />
        <circle cx={60} cy={36} r={2} fill="#ffe14a" />
        <ellipse cx={50} cy={44} rx={30} ry={6} fill="#6d35d6" />
        <circle cx={50} cy={60} r={17} fill="#ffd2ae" />
        <path d="M32 62 Q34 92 50 92 Q66 92 68 62 Q60 72 50 70 Q40 72 32 62 Z" fill="#f8fafc" />
        <Eye x={43} y={56} r={4.5} />
        <Eye x={57} y={56} r={4.5} />
        <ellipse cx={50} cy={63} rx={3.5} ry={3} fill="#f2a07b" />
        <path d="M44 70 Q50 74 56 70" fill="none" stroke="#c3cad6" strokeWidth={2.4} strokeLinecap="round" />
      </>
    ),
  },
  {
    key: "ninja",
    label: "Ninja",
    cat: "characters",
    bg: ["#c2410c", "#ffa14a"],
    draw: () => (
      <>
        <path d="M76 38 Q90 32 94 22 Q86 34 74 34 Z" fill="#e0245e" />
        <path d="M76 42 Q92 42 96 34 Q86 44 74 40 Z" fill="#e0245e" />
        <circle cx={50} cy={55} r={31} fill="#22293a" />
        <rect x={20} y={32} width={60} height={7} rx={3.5} fill="#e0245e" />
        <rect x={25} y={44} width={50} height={20} rx={10} fill="#ffd2ae" />
        <Eye x={40} y={54} r={5.5} look={1} />
        <Eye x={60} y={54} r={5.5} look={1} />
        <path d="M33 47 L46 50 M67 47 L54 50" stroke={INK} strokeWidth={2.6} strokeLinecap="round" />
      </>
    ),
  },
  {
    key: "yeti",
    label: "Yeti",
    cat: "characters",
    bg: ["#0369a1", "#7ed2fb"],
    draw: () => (
      <>
        <g fill="#f8fafc">
          {Array.from({ length: 14 }, (_, i) => {
            const a = (i * Math.PI) / 7;
            return <circle key={i} cx={50 + Math.cos(a) * 26} cy={54 + Math.sin(a) * 28} r={10} />;
          })}
        </g>
        <ellipse cx={50} cy={54} rx={28} ry={30} fill="#f8fafc" />
        <path d="M30 34 Q28 22 36 20 Q36 28 40 32 Z M70 34 Q72 22 64 20 Q64 28 60 32 Z" fill="#cbd5e1" />
        <ellipse cx={50} cy={58} rx={20} ry={18} fill="#b9e2f8" />
        <Eye x={42} y={53} r={5} />
        <Eye x={58} y={53} r={5} />
        <path d="M40 64 Q50 74 60 64 Z" fill={INK} />
        <path d="M44 64 L46 68 L48 64 Z M52 64 L54 68 L56 64 Z" fill="#fff" />
      </>
    ),
  },
  {
    key: "slime",
    label: "Slime",
    cat: "characters",
    bg: ["#be185d", "#ff86c0"],
    draw: () => (
      <>
        <path d="M16 82 Q14 58 26 44 Q36 22 50 22 Q64 22 74 44 Q86 58 84 82 Q78 88 72 82 Q66 90 58 84 Q50 92 42 84 Q34 90 28 82 Q22 88 16 82 Z" fill="#8ee03a" />
        <path d="M30 46 Q34 34 44 30" fill="none" stroke="#e0ffb8" strokeWidth={4} strokeLinecap="round" opacity={0.8} />
        <circle cx={68} cy={72} r={3} fill="#c8ff7a" />
        <circle cx={26} cy={68} r={2} fill="#c8ff7a" />
        <Eye x={40} y={54} r={8} />
        <Eye x={61} y={54} r={8} />
        <path d="M40 68 Q50 78 60 68" fill="none" stroke={INK} strokeWidth={3} strokeLinecap="round" />
      </>
    ),
  },
  {
    key: "pumpkin",
    label: "Pumpkin",
    cat: "characters",
    bg: ["#312e81", "#6d3fd9"],
    draw: () => (
      <>
        <path d="M48 26 Q46 16 54 12 L56 15 Q50 18 52 26 Z" fill="#3b7a2b" />
        <path d="M54 18 Q64 10 70 18 Q62 18 56 22 Z" fill="#4caf50" />
        <ellipse cx={34} cy={56} rx={18} ry={28} fill="#f07a1a" />
        <ellipse cx={66} cy={56} rx={18} ry={28} fill="#f07a1a" />
        <ellipse cx={50} cy={56} rx={18} ry={30} fill="#ff9a2e" />
        <path d="M34 48 L42 40 L46 50 Z M66 48 L58 40 L54 50 Z" fill="#5a2a05" />
        <path d="M32 62 Q50 82 68 62 L62 64 L58 60 L54 65 L50 61 L46 65 L42 60 L38 64 Z" fill="#5a2a05" />
        <Cheeks y={58} dx={24} color="#ffd34a" />
      </>
    ),
  },

  // --------------------------------------------------------------------------------- Abstract
  {
    key: "blob",
    label: "Blob",
    cat: "abstract",
    bg: ["#0d9488", "#9ff0d4"],
    draw: () => (
      <>
        <path d="M50 16 Q74 12 82 34 Q92 58 74 76 Q56 92 36 82 Q12 72 16 48 Q20 20 50 16 Z" fill="#8b5cf6" />
        <path d="M30 34 Q36 24 48 22" fill="none" stroke="#c4b5fd" strokeWidth={4} strokeLinecap="round" />
        <Eye x={40} y={48} r={6.5} />
        <Eye x={62} y={46} r={6.5} />
        <Cheeks y={60} dx={20} />
        <path d="M42 62 Q52 72 62 60" fill="none" stroke={INK} strokeWidth={3} strokeLinecap="round" />
      </>
    ),
  },
  {
    key: "prism",
    label: "Prism",
    cat: "abstract",
    bg: ["#111827", "#4b5563"],
    draw: () => (
      <>
        <path d="M50 12 L88 80 L50 80 Z" fill="#22d3ee" />
        <path d="M50 12 L12 80 L50 80 Z" fill="#f472b6" />
        <path d="M50 12 L66 80 L34 80 Z" fill="#facc15" opacity={0.9} />
        <Eye x={43} y={56} r={5} />
        <Eye x={57} y={56} r={5} />
        <Smile y={66} w={6} d={3} s={2.6} />
      </>
    ),
  },
  {
    key: "pixel",
    label: "Pixel",
    cat: "abstract",
    bg: ["#065f46", "#20c48a"],
    draw: () => {
      // 10×10 grid, 6 units per cell starting at (20, 20).
      const cells = ["0011111100", "0111111110", "1111111111", "1100110011", "1100110011", "1111111111", "1011111101", "1101111011", "0110000110", "0011111100"];
      return (
        <>
          {cells.flatMap((row, y) =>
            [...row].map((c, x) => (c === "1" ? <rect key={`${x}-${y}`} x={20 + x * 6} y={20 + y * 6} width={6.2} height={6.2} fill="#ffd93b" /> : null)),
          )}
          <rect x={26} y={44} width={6} height={6} fill="#ff7aa8" opacity={0.6} />
          <rect x={68} y={44} width={6} height={6} fill="#ff7aa8" opacity={0.6} />
        </>
      );
    },
  },
  {
    key: "bloom",
    label: "Bloom",
    cat: "abstract",
    bg: ["#9d174d", "#ff9fcf"],
    draw: () => (
      <>
        <g fill="#fff4fb">
          {Array.from({ length: 8 }, (_, i) => (
            <ellipse key={i} cx={50} cy={24} rx={10} ry={15} transform={`rotate(${i * 45} 50 52)`} />
          ))}
        </g>
        <circle cx={50} cy={52} r={20} fill="#ffb12b" />
        <Eye x={43} y={49} r={4.5} />
        <Eye x={57} y={49} r={4.5} />
        <Cheeks y={56} dx={12} color="#ff5f92" />
        <Smile y={57} w={5} d={3} s={2.4} />
      </>
    ),
  },
  {
    key: "split",
    label: "Duo",
    cat: "abstract",
    bg: ["#1e40af", "#5f9dff"],
    draw: () => (
      <>
        <path d="M50 22 A31 31 0 0 0 50 84 Z" fill="#ff6f91" />
        <path d="M50 22 A31 31 0 0 1 50 84 Z" fill="#ffd93b" />
        <Eye x={38} y={50} r={6} look={1} />
        <HappyEye x={62} y={50} w={6} />
        <path d="M38 64 Q50 76 62 64" fill="none" stroke={INK} strokeWidth={3} strokeLinecap="round" />
      </>
    ),
  },
  {
    key: "cube",
    label: "Cube",
    cat: "abstract",
    bg: ["#7c2d12", "#f97316"],
    draw: () => (
      <>
        <path d="M50 16 L82 33 L50 50 L18 33 Z" fill="#ffe7a3" />
        <path d="M18 33 L50 50 L50 88 L18 71 Z" fill="#ffc23d" />
        <path d="M82 33 L50 50 L50 88 L82 71 Z" fill="#f59e0b" />
        <Eye x={34} y={57} r={5} />
        <Eye x={66} y={57} r={5} />
        <path d="M38 70 Q50 78 62 70" fill="none" stroke={INK} strokeWidth={3} strokeLinecap="round" />
      </>
    ),
  },
  {
    key: "sparkle",
    label: "Sparkle",
    cat: "abstract",
    bg: ["#4c1d95", "#b06cff"],
    draw: () => (
      <>
        <path d="M80 14 Q82 22 88 24 Q82 26 80 34 Q78 26 72 24 Q78 22 80 14 Z" fill="#fff" opacity={0.7} />
        <path d="M50 8 Q56 44 92 52 Q56 60 50 94 Q44 60 8 52 Q44 44 50 8 Z" fill="#ffe14a" />
        <Eye x={43} y={50} r={4.5} />
        <Eye x={57} y={50} r={4.5} />
        <Cheeks y={57} dx={12} />
        <Smile y={58} w={5} d={3} s={2.4} />
      </>
    ),
  },
];

/** Old emoji-avatar keys (stored on existing profiles) → the character that replaces them. */
export const LEGACY_AVATARS: Record<string, string> = {
  ocean: "robot",
  whale: "monster",
  dolphin: "alien",
  octopus: "octo",
  turtle: "frog",
  crab: "fox",
  fish: "panda",
  shell: "bear",
  coral: "cat",
  star: "owl",
  moon: "ghost",
  sun: "sunny",
};

export const DEFAULT_AVATAR = AVATAR_ART[0].key;

/** The character for a stored key (legacy keys included); unknown keys get the default. */
export function avatarArt(key: string): Art {
  const k = LEGACY_AVATARS[key] ?? key;
  return AVATAR_ART.find((a) => a.key === k) ?? AVATAR_ART[0];
}

export function AvatarSvg({ avatarKey }: { avatarKey: string }) {
  const a = avatarArt(avatarKey);
  const gid = `av-${a.key}`;
  return (
    <svg viewBox="0 0 100 100" width="100%" height="100%" role="img" aria-label={a.label} focusable="false">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={a.bg[0]} />
          <stop offset="1" stopColor={a.bg[1]} />
        </linearGradient>
      </defs>
      <rect width={100} height={100} fill={`url(#${gid})`} />
      {a.draw()}
    </svg>
  );
}
