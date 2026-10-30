// Language identifiers come from mpv tracks ("ara", "ar"), file names ("Arabic", "ar"),
// and addons ("ara", "pob"). Everything is normalised to an ISO 639-2/B code.

type Lang = { code: string; name: string; aliases: string[] };

const LANGS: Lang[] = [
  { code: "ara", name: "Arabic", aliases: ["ar", "arabic", "العربية", "عربي", "ar-sa", "ar-eg", "ar-ae"] },
  { code: "eng", name: "English", aliases: ["en", "english", "en-us", "en-gb"] },
  { code: "fre", name: "French", aliases: ["fr", "fra", "french", "français", "francais"] },
  { code: "ger", name: "German", aliases: ["de", "deu", "german", "deutsch"] },
  { code: "spa", name: "Spanish", aliases: ["es", "spanish", "español", "espanol", "es-es", "es-419", "spl", "ea"] },
  { code: "ita", name: "Italian", aliases: ["it", "italian", "italiano"] },
  { code: "por", name: "Portuguese", aliases: ["pt", "portuguese", "português", "pt-pt"] },
  { code: "pob", name: "Portuguese (Brazil)", aliases: ["pt-br", "ptbr", "brazilian", "pb"] },
  { code: "rus", name: "Russian", aliases: ["ru", "russian", "русский"] },
  { code: "tur", name: "Turkish", aliases: ["tr", "turkish", "türkçe", "turkce"] },
  { code: "per", name: "Persian", aliases: ["fa", "fas", "persian", "farsi", "فارسی"] },
  { code: "urd", name: "Urdu", aliases: ["ur", "urdu"] },
  { code: "heb", name: "Hebrew", aliases: ["he", "hebrew", "iw"] },
  { code: "hin", name: "Hindi", aliases: ["hi", "hindi"] },
  { code: "ind", name: "Indonesian", aliases: ["id", "indonesian", "bahasa"] },
  { code: "may", name: "Malay", aliases: ["ms", "msa", "malay"] },
  { code: "dut", name: "Dutch", aliases: ["nl", "nld", "dutch", "nederlands"] },
  { code: "pol", name: "Polish", aliases: ["pl", "polish", "polski"] },
  { code: "swe", name: "Swedish", aliases: ["sv", "swedish"] },
  { code: "nor", name: "Norwegian", aliases: ["no", "nb", "nob", "norwegian"] },
  { code: "dan", name: "Danish", aliases: ["da", "danish"] },
  { code: "fin", name: "Finnish", aliases: ["fi", "finnish"] },
  { code: "est", name: "Estonian", aliases: ["et", "estonian"] },
  { code: "gre", name: "Greek", aliases: ["el", "ell", "greek"] },
  { code: "cze", name: "Czech", aliases: ["cs", "ces", "czech"] },
  { code: "hun", name: "Hungarian", aliases: ["hu", "hungarian"] },
  { code: "rum", name: "Romanian", aliases: ["ro", "ron", "romanian"] },
  { code: "hrv", name: "Croatian", aliases: ["hr", "croatian", "scr"] },
  { code: "slv", name: "Slovenian", aliases: ["sl", "slovenian"] },
  { code: "srp", name: "Serbian", aliases: ["sr", "serbian", "scc"] },
  { code: "bul", name: "Bulgarian", aliases: ["bg", "bulgarian"] },
  { code: "ukr", name: "Ukrainian", aliases: ["uk", "ukrainian"] },
  { code: "chi", name: "Chinese", aliases: ["zh", "zho", "chinese", "zh-cn", "zh-tw", "chs", "cht", "ze"] },
  { code: "jpn", name: "Japanese", aliases: ["ja", "japanese"] },
  { code: "kor", name: "Korean", aliases: ["ko", "korean"] },
  { code: "tha", name: "Thai", aliases: ["th", "thai"] },
  { code: "vie", name: "Vietnamese", aliases: ["vi", "vietnamese"] },
  { code: "ben", name: "Bengali", aliases: ["bn", "bengali"] },
  { code: "kur", name: "Kurdish", aliases: ["ku", "kurdish"] },
];

const INDEX = new Map<string, Lang>();
for (const l of LANGS) {
  INDEX.set(l.code, l);
  INDEX.set(l.name.toLowerCase(), l);
  for (const a of l.aliases) INDEX.set(a, l);
}

/** Canonical ISO 639-2/B code, or null when the input is not a known language. */
export function normalizeLang(input: string | null | undefined): string | null {
  if (!input) return null;
  const key = input.trim().toLowerCase().replace(/_/g, "-");
  return INDEX.get(key)?.code ?? null;
}

/** Content detection on the Rust side reports ISO 639-2/T codes; map them in. */
export function langFromDetected(code: string | null): string | null {
  return code === "fas" ? "per" : code === "ell" ? "gre" : code === "zho" ? "chi" : normalizeLang(code);
}

export function langName(code: string | null | undefined): string {
  if (!code) return "Unknown";
  return INDEX.get(code)?.name ?? code.toUpperCase();
}

export const SUBTITLE_LANGUAGE_CHOICES = LANGS.map((l) => ({ code: l.code, name: l.name }));
