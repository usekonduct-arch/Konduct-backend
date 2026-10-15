import { REGION } from "../config";

/**
 * The server's public address, for links that leave it (receipt checks, ad images):
 * PUBLIC_BASE_URL (or the older RECEIPT_BASE_URL), else Render's own URL, else the Cloud Function.
 */
export function publicBase() {
  const set = process.env.PUBLIC_BASE_URL ?? process.env.RECEIPT_BASE_URL ?? process.env.RENDER_EXTERNAL_URL;
  if (set) return set.replace(/\/$/, "");
  return `https://${REGION}-${process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT}.cloudfunctions.net`;
}
