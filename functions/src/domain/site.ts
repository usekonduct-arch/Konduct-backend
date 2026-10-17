/**
 * The public website's blog and careers (konduct-landing). Staff write posts and job openings here;
 * the website reads published ones straight from Firestore (rules allow public reads of published
 * posts and open or closed jobs only) and pre-renders each into static HTML at build time.
 *
 * After any change we ping SITE_DEPLOY_HOOK (a Vercel deploy hook URL), so the static pages,
 * sitemap and RSS feed rebuild within a couple of minutes. Without it, the website still shows new
 * content by loading it in the browser; search engines just see it after the next deploy.
 *
 * Job applications are written by the website straight into `applications` (rules validate them);
 * staff move them through the hiring stages here.
 */
import { randomBytes } from "node:crypto";
import { logger } from "firebase-functions";
import { z } from "zod";

import type { Actor } from "../lib/guards";
import { audit } from "../lib/audit";
import { db, stamp, touched } from "../lib/db";
import { fail } from "../lib/errors";

const id = z.string().regex(/^[A-Za-z0-9_-]{6,40}$/);
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single dashes, like campus-rides-made-easy.")
  .min(3)
  .max(80);
const line = (max: number) => z.string().trim().max(max);
const httpsOrEmpty = z.union([z.literal(""), z.string().trim().url().max(500).refine((v) => v.startsWith("https://"), "Use an https:// address.")]);

export const UpsertPost = z.strictObject({
  id: id.optional(),
  slug,
  title: line(120).min(8, "Give the post a title of at least 8 characters."),
  excerpt: line(300).min(40, "Write a summary of at least 40 characters. It shows in search results and link previews."),
  body: z.string().max(50_000).min(200, "The post needs at least a couple of paragraphs."),
  coverUrl: httpsOrEmpty,
  coverAlt: line(200),
  tags: z.array(line(30).min(2)).max(6),
  authorName: line(80).min(2),
  authorRole: line(80),
  seoTitle: line(70),
  seoDescription: line(160),
  status: z.enum(["draft", "published"]),
});

export const UpsertJob = z.strictObject({
  id: id.optional(),
  slug,
  title: line(100).min(3),
  team: line(60).min(2),
  location: line(80).min(2),
  workplace: z.enum(["onsite", "hybrid", "remote"]),
  employment: z.enum(["FULL_TIME", "PART_TIME", "CONTRACTOR", "INTERN", "VOLUNTEER"]),
  summary: line(300).min(40, "Write a summary of at least 40 characters."),
  body: z.string().max(30_000).min(150, "Describe the role: what they'll do and what you're looking for."),
  salaryMinNaira: z.number().int().min(0).max(100_000_000).nullable(),
  salaryMaxNaira: z.number().int().min(0).max(100_000_000).nullable(),
  salaryUnit: z.enum(["MONTH", "YEAR"]),
  closesAtMs: z.number().int().positive().nullable(),
  status: z.enum(["draft", "open", "closed"]),
});

export const DeleteSiteItem = z.strictObject({ id });

export const APPLICATION_STAGES = ["new", "reviewing", "interview", "offer", "hired", "rejected"] as const;
export const SetApplication = z.strictObject({ id, status: z.enum(APPLICATION_STAGES), staffNote: line(1000) });

const newId = () => randomBytes(12).toString("base64url");
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Refuses a slug another post (or job) already uses. */
async function assertSlugFree(collection: "posts" | "jobs", value: string, self: string) {
  const same = await db.collection(collection).where("slug", "==", value).limit(2).get();
  if (same.docs.some((d) => d.id !== self)) fail("already-exists", "slug_taken", "Another one already uses that web address. Change the slug.");
}

export async function upsertPost(actor: Actor, input: z.infer<typeof UpsertPost>) {
  const { id: given, ...fields } = input;
  const postId = given ?? newId();
  const ref = db.doc(`posts/${postId}`);
  const existing = given ? await ref.get() : null;
  if (given && !existing?.exists) fail("not-found", "no_post", "No such post.");
  await assertSlugFree("posts", fields.slug, postId);
  if (fields.coverUrl && !fields.coverAlt) fail("invalid-argument", "cover_alt", "Describe the cover picture for people using screen readers (and for Google Images).");

  const now = Date.now();
  const wasPublished = existing?.get("status") === "published";
  await ref.set(
    {
      ...fields,
      tags: [...new Set(fields.tags.map((t) => t.toLowerCase()))],
      readMinutes: Math.max(1, Math.round(words(fields.body) / 220)),
      // The first publish sets the date; later edits keep it and move updatedAtMs.
      publishedAtMs: fields.status === "published" ? ((existing?.get("publishedAtMs") as number | undefined) ?? now) : (existing?.get("publishedAtMs") ?? null),
      updatedAtMs: now,
      updatedBy: actor.uid,
      ...(existing?.exists ? touched() : { createdBy: actor.uid, ...stamp() }),
    },
    { merge: true },
  );
  await audit({ actor: actor.uid, action: given ? "post.update" : "post.create", target: ref.path, after: { slug: fields.slug, status: fields.status } });
  if (fields.status === "published" || wasPublished) rebuildSite(`post ${fields.slug}`);
  return { id: postId, slug: fields.slug };
}

export async function deletePost(actor: Actor, input: z.infer<typeof DeleteSiteItem>) {
  const ref = db.doc(`posts/${input.id}`);
  const snap = await ref.get();
  if (!snap.exists) fail("not-found", "no_post", "No such post.");
  await ref.delete();
  await audit({ actor: actor.uid, action: "post.delete", target: ref.path, before: { slug: snap.get("slug") } });
  if (snap.get("status") === "published") rebuildSite(`post ${snap.get("slug")} deleted`);
  return { deleted: input.id };
}

export async function upsertJob(actor: Actor, input: z.infer<typeof UpsertJob>) {
  const { id: given, ...fields } = input;
  if (fields.salaryMinNaira != null && fields.salaryMaxNaira != null && fields.salaryMaxNaira < fields.salaryMinNaira) fail("invalid-argument", "bad_salary", "The top of the pay range is below the bottom.");
  if (fields.status === "open" && fields.closesAtMs && fields.closesAtMs < Date.now()) fail("invalid-argument", "closes_past", "The closing date has passed. Pick a later date or mark the role closed.");
  const jobId = given ?? newId();
  const ref = db.doc(`jobs/${jobId}`);
  const existing = given ? await ref.get() : null;
  if (given && !existing?.exists) fail("not-found", "no_job", "No such job.");
  await assertSlugFree("jobs", fields.slug, jobId);

  const now = Date.now();
  const wasPublic = ["open", "closed"].includes(existing?.get("status") as string);
  await ref.set(
    {
      ...fields,
      postedAtMs: fields.status === "open" ? ((existing?.get("postedAtMs") as number | undefined) ?? now) : (existing?.get("postedAtMs") ?? null),
      updatedAtMs: now,
      updatedBy: actor.uid,
      ...(existing?.exists ? touched() : { createdBy: actor.uid, applications: 0, ...stamp() }),
    },
    { merge: true },
  );
  await audit({ actor: actor.uid, action: given ? "job.update" : "job.create", target: ref.path, after: { slug: fields.slug, status: fields.status } });
  if (fields.status !== "draft" || wasPublic) rebuildSite(`job ${fields.slug}`);
  return { id: jobId, slug: fields.slug };
}

export async function deleteJob(actor: Actor, input: z.infer<typeof DeleteSiteItem>) {
  const ref = db.doc(`jobs/${input.id}`);
  const snap = await ref.get();
  if (!snap.exists) fail("not-found", "no_job", "No such job.");
  const apps = await db.collection("applications").where("jobId", "==", input.id).limit(1).get();
  if (!apps.empty) fail("failed-precondition", "has_applications", "People have applied for this role. Mark it closed instead, so their applications stay linked.");
  await ref.delete();
  await audit({ actor: actor.uid, action: "job.delete", target: ref.path, before: { slug: snap.get("slug") } });
  if (snap.get("status") !== "draft") rebuildSite(`job ${snap.get("slug")} deleted`);
  return { deleted: input.id };
}

export async function setApplication(actor: Actor, input: z.infer<typeof SetApplication>) {
  const ref = db.doc(`applications/${input.id}`);
  const snap = await ref.get();
  if (!snap.exists) fail("not-found", "no_application", "No such application.");
  await ref.update({ status: input.status, staffNote: input.staffNote, reviewedBy: actor.uid, reviewedAtMs: Date.now(), ...touched() });
  await audit({ actor: actor.uid, action: "application.status", target: ref.path, before: { status: snap.get("status") }, after: { status: input.status } });
  return { status: input.status };
}

/* ------------------------------------------------------------------ static rebuild */

let timer: NodeJS.Timeout | null = null;
const reasons = new Set<string>();

/** Asks the host to rebuild the website. Several edits in a row become one build. */
export function rebuildSite(reason: string) {
  const hook = process.env.SITE_DEPLOY_HOOK;
  if (!hook) return;
  reasons.add(reason);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const why = [...reasons].join(", ");
    reasons.clear();
    fetch(hook, { method: "POST" })
      .then((r) => logger.info("website rebuild requested", { why, status: r.status }))
      .catch((e) => logger.warn("website rebuild request failed", { why, err: (e as Error).message }));
  }, 20_000);
  timer.unref?.();
}
