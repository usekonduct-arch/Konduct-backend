/**
 * Push notifications in the person's language. The apps save the language they're set to on
 * users/{uid}.lang (setLanguage, registerDevice); the inbox keeps the English text and the apps
 * translate it on screen, so only the push itself is translated here.
 *
 * Messages are matched against English templates: "{amount} added" matches "₦500 added" and
 * the value is carried into the translation. Text with no template (a support reply, a staff
 * message) is sent as written. Parts joined with " · " are translated one by one.
 *
 * Hausa uses the respectful plural (ku, ɗinku), which also avoids guessing the reader's gender.
 */

export const LANGS = ["en", "pcm", "yo", "ha"] as const;
export type Lang = (typeof LANGS)[number];

export const isLang = (v: unknown): v is Lang => typeof v === "string" && (LANGS as readonly string[]).includes(v);

type Catalog = Record<string, string>;

const pcm: Catalog = {
  "Dispute reviewed": "We don check your complain",
  "We checked {ref}: no refund is due. Tap for details.": "We check {ref}: no refund dey for am. Tap make you see why.",
  "{amount} refunded": "We don return {amount} give you",
  "Your dispute on {ref} is resolved.": "We don settle your complain for {ref}.",
  "{amount} added": "{amount} don enter",
  "Your Konduct wallet is topped up.": "Money don enter your Konduct wallet.",
  "Your bank transfer has landed in your Konduct wallet.": "The money wey you transfer from bank don land for your Konduct wallet.",
  "{amount} received": "You don collect {amount}",
  "1 rider": "1 passenger",
  "Cash at the park": "Dem pay cash for park",
  "{n} riders": "{n} passengers",
  "New payout account requested": "Person wan add new bank account",
  "****{last4} will be checked. Not you? Tell an agent now.": "We go check ****{last4}. No be you? Tell Konduct agent sharp sharp.",
  "{amount} paid out": "We don send {amount} go your bank",
  "Sent to your bank account ****{last4}.": "E don go your bank account ****{last4}.",
  "Payout didn't go through": "Payout no go",
  "{amount} is back in your Konduct wallet. Check your bank details, or talk to an agent.":
    "{amount} don return enter your Konduct wallet. Check your bank details, or talk to agent.",
  "Konduct support replied": "Konduct support don reply you",
  "Low balance": "Your money don low",
  "You have {amount} left, not enough for another {fare} ride. Top up before your next trip.":
    "Na {amount} remain, e no reach another {fare} ride. Top up before your next trip.",
  "A bus is at {park}": "Bus dey for {park} now",
  "{plate} has about {n} seats free. Tap to see it.": "{plate} get like {n} empty seats. Tap make you see am.",
  "{plate} has about 1 seat free. Tap to see it.": "{plate} get like 1 empty seat. Tap make you see am.",
  "You earned {amount}": "You don collect {amount}",
  "{name} took their first Konduct ride with your code.": "{name} don take first Konduct ride with your code.",
  "{amount} welcome bonus": "{amount} welcome bonus",
  "Thanks for joining Konduct with a friend's code.": "Thank you as you join Konduct with your padi code.",
};

const yo: Catalog = {
  "Dispute reviewed": "A ti ṣàyẹ̀wò ẹ̀sùn rẹ",
  "We checked {ref}: no refund is due. Tap for details.": "A ti ṣàyẹ̀wò {ref}: kò sí owó tí a ó dá padà. Tẹ̀ ẹ́ fún àlàyé.",
  "{amount} refunded": "A ti dá {amount} padà fún ọ",
  "Your dispute on {ref} is resolved.": "A ti yanjú ẹ̀sùn rẹ lórí {ref}.",
  "{amount} added": "{amount} ti wọlé",
  "Your Konduct wallet is topped up.": "A ti fi owó kún àpò Konduct rẹ.",
  "Your bank transfer has landed in your Konduct wallet.": "Owó tí o fi ránṣẹ́ láti báǹkì ti wọ àpò Konduct rẹ.",
  "{amount} received": "O ti gba {amount}",
  "1 rider": "Èrò kan",
  "Cash at the park": "Owó ní ọwọ́ ní ibùdókọ̀",
  "{n} riders": "Èrò {n}",
  "New payout account requested": "Ìbéèrè fún àkáǹtì báǹkì tuntun",
  "****{last4} will be checked. Not you? Tell an agent now.": "A ó ṣàyẹ̀wò ****{last4}. Kì í ṣe ìwọ? Sọ fún aṣojú Konduct báyìí.",
  "{amount} paid out": "A ti san {amount} sí báǹkì rẹ",
  "Sent to your bank account ****{last4}.": "A ti fi ránṣẹ́ sí àkáǹtì báǹkì rẹ ****{last4}.",
  "Payout didn't go through": "Owó tí a fẹ́ san kò lọ",
  "{amount} is back in your Konduct wallet. Check your bank details, or talk to an agent.":
    "{amount} ti padà sínú àpò Konduct rẹ. Ṣàyẹ̀wò àlàyé báǹkì rẹ, tàbí bá aṣojú sọ̀rọ̀.",
  "Konduct support replied": "Ẹ̀ka ìrànlọ́wọ́ Konduct ti fèsì",
  "Low balance": "Owó inú àpò rẹ ti kéré",
  "You have {amount} left, not enough for another {fare} ride. Top up before your next trip.":
    "{amount} ló kù, kò tó fún ìrìn {fare} mìíràn. Fi owó kún un kí o tó wọkọ̀ tó kàn.",
  "A bus is at {park}": "Bọ́ọ̀sì kan wà ní {park}",
  "{plate} has about {n} seats free. Tap to see it.": "Àyè ìjókòó bíi {n} ló ṣófo nínú {plate}. Tẹ̀ ẹ́ láti wò ó.",
  "{plate} has about 1 seat free. Tap to see it.": "Àyè ìjókòó kan ló ṣófo nínú {plate}. Tẹ̀ ẹ́ láti wò ó.",
  "You earned {amount}": "O ti jèrè {amount}",
  "{name} took their first Konduct ride with your code.": "{name} wọ ọkọ̀ Konduct fún ìgbà àkọ́kọ́ pẹ̀lú kóòdù rẹ.",
  "{amount} welcome bonus": "Ẹ̀bùn ìkíni {amount}",
  "Thanks for joining Konduct with a friend's code.": "A dúpẹ́ pé o darapọ̀ mọ́ Konduct pẹ̀lú kóòdù ọ̀rẹ́ rẹ.",
};

const ha: Catalog = {
  "Dispute reviewed": "An duba ƙorafinku",
  "We checked {ref}: no refund is due. Tap for details.": "Mun duba {ref}: babu kuɗin da za a mayar. Ku taɓa don ƙarin bayani.",
  "{amount} refunded": "An mayar muku da {amount}",
  "Your dispute on {ref} is resolved.": "An warware ƙorafinku kan {ref}.",
  "{amount} added": "An ƙara {amount}",
  "Your Konduct wallet is topped up.": "An ƙara kuɗi a walat ɗinku na Konduct.",
  "Your bank transfer has landed in your Konduct wallet.": "Kuɗin da kuka tura daga banki sun shiga walat ɗinku na Konduct.",
  "{amount} received": "An karɓi {amount}",
  "1 rider": "Fasinja 1",
  "Cash at the park": "Kuɗin hannu a tasha",
  "{n} riders": "Fasinjoji {n}",
  "New payout account requested": "An nemi sabon asusun banki",
  "****{last4} will be checked. Not you? Tell an agent now.": "Za a duba ****{last4}. Ba ku ba ne? Ku sanar da wakilin Konduct yanzu.",
  "{amount} paid out": "An tura {amount} zuwa bankinku",
  "Sent to your bank account ****{last4}.": "An tura zuwa asusun bankinku ****{last4}.",
  "Payout didn't go through": "Biyan bai yi nasara ba",
  "{amount} is back in your Konduct wallet. Check your bank details, or talk to an agent.":
    "{amount} ya dawo cikin walat ɗinku na Konduct. Ku duba bayanan bankinku, ko ku yi magana da wakili.",
  "Konduct support replied": "Tallafin Konduct ya amsa muku",
  "Low balance": "Kuɗinku sun yi ƙasa",
  "You have {amount} left, not enough for another {fare} ride. Top up before your next trip.":
    "Saura {amount}, bai isa wani hawan {fare} ba. Ku ƙara kuɗi kafin tafiyarku ta gaba.",
  "A bus is at {park}": "Akwai bas a {park}",
  "{plate} has about {n} seats free. Tap to see it.": "{plate} na da kujeru kusan {n} babu kowa. Ku taɓa don gani.",
  "{plate} has about 1 seat free. Tap to see it.": "{plate} na da kujera 1 babu kowa. Ku taɓa don gani.",
  "You earned {amount}": "Kun samu {amount}",
  "{name} took their first Konduct ride with your code.": "An yi hawan Konduct na farko na {name} da lambarku.",
  "{amount} welcome bonus": "Kyautar maraba ta {amount}",
  "Thanks for joining Konduct with a friend's code.": "Mun gode da kuka shiga Konduct da lambar abokinku.",
};

const CATALOGS: Record<Exclude<Lang, "en">, Catalog> = { pcm, yo, ha };

type Template = { re: RegExp; names: string[]; out: string };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "{amount} added" → /^(.+?) added$/ with names ["amount"]. */
function compile(source: string, out: string): Template {
  const names: string[] = [];
  const re = source
    .split(/(\{[a-zA-Z0-9]+\})/)
    .map((part) => {
      const m = /^\{([a-zA-Z0-9]+)\}$/.exec(part);
      if (!m) return escape(part);
      names.push(m[1]);
      return "(.+?)";
    })
    .join("");
  return { re: new RegExp(`^${re}$`, "s"), names, out };
}

const compiled = new Map<Lang, { exact: Catalog; templates: Template[] }>();

function tables(lang: Exclude<Lang, "en">) {
  let t = compiled.get(lang);
  if (!t) {
    const exact: Catalog = {};
    const templates: Template[] = [];
    for (const [k, v] of Object.entries(CATALOGS[lang])) {
      if (k.includes("{")) templates.push(compile(k, v));
      else exact[k] = v;
    }
    // Longer templates first: they say more, so they win over a shorter one that also matches.
    templates.sort((a, b) => b.re.source.length - a.re.source.length);
    compiled.set(lang, (t = { exact, templates }));
  }
  return t;
}

function one(lang: Exclude<Lang, "en">, text: string): string | null {
  const { exact, templates } = tables(lang);
  if (Object.hasOwn(exact, text)) return exact[text];
  for (const t of templates) {
    const m = t.re.exec(text);
    if (!m) continue;
    const values = Object.fromEntries(t.names.map((n, i) => [n, m[i + 1]]));
    return t.out.replace(/\{([a-zA-Z0-9]+)\}/g, (_, n: string) => values[n] ?? `{${n}}`);
  }
  return null;
}

/** [text] in [lang]; English, or anything without a translation, comes back unchanged. */
export function translate(lang: unknown, text: string): string {
  if (!isLang(lang) || lang === "en" || !text) return text;
  const whole = one(lang, text);
  if (whole != null) return whole;
  if (text.includes(" · ")) return text.split(" · ").map((p) => one(lang, p) ?? p).join(" · ");
  return text;
}
