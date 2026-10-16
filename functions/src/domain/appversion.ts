/**
 * Which app builds may still be used (config/app). Each app compares its own build number with
 * minBuild when it starts: below it, the app shows only an "Update Konduct" screen, so a build
 * with a money bug can be retired. Below latestBuild it offers the update without forcing it.
 * Anyone may read the document (the check runs before sign-in); only admins write it.
 */
import { z } from "zod";

import { audit } from "../lib/audit";
import { db, touched } from "../lib/db";
import type { Actor } from "../lib/guards";

export const appConfigRef = () => db.doc("config/app");

const AppEntry = z.strictObject({
  minBuild: z.number().int().min(0).max(1_000_000),
  latestBuild: z.number().int().min(0).max(1_000_000),
  /** Where the update is: the Play Store listing or the APK download page. */
  updateUrl: z.string().url().startsWith("https://").max(300),
});

export const SetAppVersions = z
  .strictObject({
    rider: AppEntry.optional(),
    driver: AppEntry.optional(),
    reason: z.string().min(5).max(200),
  })
  .refine((v) => [v.rider, v.driver].every((e) => !e || e.latestBuild >= e.minBuild), { message: "The latest build can't be lower than the minimum." });

export async function setAppVersions(actor: Actor, input: z.infer<typeof SetAppVersions>) {
  const { reason, ...patch } = input;
  await db.runTransaction(async (tx) => {
    const before = (await tx.get(appConfigRef())).data() ?? {};
    tx.set(appConfigRef(), { ...patch, ...touched() }, { merge: true });
    audit({ actor: actor.uid, action: "app.versions.set", target: "config/app", before, after: { ...patch, reason }, ip: actor.ip }, tx);
  });
  return { ok: true };
}
