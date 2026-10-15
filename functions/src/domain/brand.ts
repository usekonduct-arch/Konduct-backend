/**
 * Konduct's social handles and hashtag, which the apps put in the caption when someone shares a
 * ride or their monthly Wrapped. Admins and ops set them in the console; config/brand is readable
 * by anyone signed in.
 */
import { z } from "zod";

import { audit } from "../lib/audit";
import { db, touched } from "../lib/db";
import type { Actor } from "../lib/guards";

const handle = z
  .string()
  .trim()
  .max(31)
  .transform((s) => (s && !s.startsWith("@") ? `@${s}` : s))
  .pipe(z.string().regex(/^(@[A-Za-z0-9._]{1,30})?$/, "Handles use letters, numbers, dots and underscores."));

export const SetBrand = z.strictObject({
  instagram: handle,
  x: handle,
  tiktok: handle,
  facebook: handle,
  hashtag: z
    .string()
    .trim()
    .max(31)
    .transform((s) => (s && !s.startsWith("#") ? `#${s}` : s))
    .pipe(z.string().regex(/^(#[A-Za-z0-9_]{2,30})?$/, "Hashtags use letters, numbers and underscores.")),
  website: z.string().trim().max(120).pipe(z.string().regex(/^(https:\/\/\S+)?$/, "Start the website with https://")),
});

export async function setBrand(actor: Actor, input: z.infer<typeof SetBrand>) {
  const ref = db.doc("config/brand");
  await db.runTransaction(async (tx) => {
    const before = (await tx.get(ref)).data() ?? null;
    tx.set(ref, { ...input, ...touched() }, { merge: true });
    audit({ actor: actor.uid, action: "brand.set", target: ref.path, before, after: input, ip: actor.ip }, tx);
  });
  return input;
}
