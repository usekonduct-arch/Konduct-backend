/**
 * Firestore rules attack tests (SEC-AUTH-02, SEC-AUTH-05): what a modified app could try with a
 * real signed-in account.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, query, where, serverTimestamp } from "firebase/firestore";

let env: RulesTestEnvironment;
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":");

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-konduct-rules",
    firestore: { rules: readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8"), host, port: Number(port) },
  });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users/alice"), { role: "rider", status: "active" });
    await setDoc(doc(db, "users/bob"), { role: "rider", status: "active" });
    await setDoc(doc(db, "users/tunde"), { role: "driver", status: "active" });
    await setDoc(doc(db, "users/sam"), { role: "support", status: "active" });
    await setDoc(doc(db, "users/alice/notifications/n1"), { title: "hi", read: false });
    await setDoc(doc(db, "wallets/rider_alice"), { ownerUid: "alice", balanceKobo: 5000 });
    await setDoc(doc(db, "wallets/rider_bob"), { ownerUid: "bob", balanceKobo: 9000 });
    await setDoc(doc(db, "wallets/platform_bachs_float"), { ownerUid: null, balanceKobo: 1 });
    await setDoc(doc(db, "transactions/fare_1"), { payerUid: "alice", driverUid: "tunde", totalKobo: 20000, offlineCode: "K7Q2MX" });
    await setDoc(doc(db, "driverFeed/tunde/items/fare_1"), { amountKobo: 20000 });
    await setDoc(doc(db, "pins/alice"), { hash: "x", salt: "y" });
    await setDoc(doc(db, "ledgerEntries/e1"), { account: "rider_alice" });
    await setDoc(doc(db, "flags/f1"), { type: "velocity" });
    await setDoc(doc(db, "routes/r1"), { name: "Main Gate", fareKobo: 20000 });
    await setDoc(doc(db, "config/switches"), { paymentsPaused: false });
    await setDoc(doc(db, "config/fleet"), { busSeats: 7 });
    await setDoc(doc(db, "landmarks/gate"), { name: "Main gate", lat: 7.7553, lng: 4.5476, active: true });
    await setDoc(doc(db, "ratings/fare_1"), { driverUid: "tunde", riderUid: "alice", stars: 2, comment: "Rough driving" });
    await setDoc(doc(db, "parks/shasha"), { name: "Shasha park", location: "Shasha, Osogbo", busCount: 4, active: true });
    await setDoc(doc(db, "vehicles/v1"), { plate: "OS 452 KJA", driverUid: "tunde", load: { taken: 3 } });
  });
});

after(async () => env?.cleanup());

const as = (uid: string, claims: Record<string, unknown> = {}) => env.authenticatedContext(uid, claims).firestore();

describe("riders", () => {
  test("read their own wallet, receipt and profile", async () => {
    const db = as("alice", { role: "rider" });
    await assertSucceeds(getDoc(doc(db, "wallets/rider_alice")));
    await assertSucceeds(getDoc(doc(db, "transactions/fare_1")));
    await assertSucceeds(getDoc(doc(db, "users/alice")));
    await assertSucceeds(getDocs(query(collection(db, "transactions"), where("payerUid", "==", "alice"))));
  });

  test("cannot read anyone else's wallet, receipt or profile by changing an id (BOLA)", async () => {
    const db = as("bob", { role: "rider" });
    await assertFails(getDoc(doc(db, "wallets/rider_alice")));
    await assertFails(getDoc(doc(db, "transactions/fare_1")));
    await assertFails(getDoc(doc(db, "users/alice")));
    await assertFails(getDocs(collection(db, "wallets")));
    await assertFails(getDocs(query(collection(db, "transactions"), where("payerUid", "==", "alice"))));
    await assertFails(getDoc(doc(db, "wallets/platform_bachs_float")));
  });

  test("cannot write money, identity or roles, even their own", async () => {
    const db = as("alice", { role: "rider" });
    await assertFails(updateDoc(doc(db, "wallets/rider_alice"), { balanceKobo: 99_999_999 }));
    await assertFails(setDoc(doc(db, "wallets/rider_eve"), { ownerUid: "alice", balanceKobo: 1e9 }));
    await assertFails(updateDoc(doc(db, "users/alice"), { role: "admin" }));
    await assertFails(updateDoc(doc(db, "users/alice"), { status: "active", kycTier: 2 }));
    await assertFails(setDoc(doc(db, "transactions/fake"), { payerUid: "bob", totalKobo: 1 }));
    await assertFails(deleteDoc(doc(db, "transactions/fare_1")));
    await assertFails(setDoc(doc(db, "ledgerEntries/forged"), { account: "rider_alice", amountKobo: 1e9 }));
    await assertFails(setDoc(doc(db, "config/switches"), { paymentsPaused: true }));
    await assertFails(setDoc(doc(db, "driverFeed/tunde/items/fake"), { amountKobo: 1 }));
  });

  test("never see secrets: PINs, ledger, flags, audit", async () => {
    const db = as("alice", { role: "rider" });
    await assertFails(getDoc(doc(db, "pins/alice")));
    await assertFails(getDoc(doc(db, "ledgerEntries/e1")));
    await assertFails(getDoc(doc(db, "flags/f1")));
    await assertFails(getDocs(collection(db, "auditLogs")));
  });

  test("may only flip `read` on their own notifications", async () => {
    const db = as("alice", { role: "rider" });
    await assertSucceeds(updateDoc(doc(db, "users/alice/notifications/n1"), { read: true }));
    await assertFails(updateDoc(doc(db, "users/alice/notifications/n1"), { title: "spoofed" }));
    await assertFails(updateDoc(doc(as("bob"), "users/alice/notifications/n1"), { read: true }));
  });
});

describe("drivers", () => {
  test("read their own payment feed, not the rider's receipt (which holds the offline code)", async () => {
    const db = as("tunde", { role: "driver" });
    await assertSucceeds(getDoc(doc(db, "driverFeed/tunde/items/fare_1")));
    await assertFails(getDoc(doc(db, "transactions/fare_1")));
    await assertFails(getDoc(doc(as("bob"), "driverFeed/tunde/items/fare_1")));
  });

  test("see their own bus and its seats; riders don't", async () => {
    await assertSucceeds(getDoc(doc(as("tunde", { role: "driver" }), "vehicles/v1")));
    await assertFails(getDoc(doc(as("alice", { role: "rider" }), "vehicles/v1")));
    await assertFails(updateDoc(doc(as("tunde", { role: "driver" }), "vehicles/v1"), { load: { taken: 0 } }));
  });
});

describe("parks and seats per bus", () => {
  test("anyone signed in reads them; nobody writes them from an app", async () => {
    for (const db of [as("alice", { role: "rider" }), as("tunde", { role: "driver" })]) {
      await assertSucceeds(getDoc(doc(db, "parks/shasha")));
      await assertSucceeds(getDocs(query(collection(db, "parks"), where("active", "==", true))));
      await assertSucceeds(getDoc(doc(db, "config/fleet")));
      await assertSucceeds(getDoc(doc(db, "landmarks/gate")));
      await assertFails(setDoc(doc(db, "landmarks/fake"), { name: "Fake", lat: 0, lng: 0, active: true }));
      // Who wrote what about a driver is staff-only: not the rider who wrote it, not the driver.
      await assertFails(getDoc(doc(db, "ratings/fare_1")));
      await assertFails(setDoc(doc(db, "ratings/fare_2"), { driverUid: "tunde", stars: 1 }));
      await assertFails(updateDoc(doc(db, "parks/shasha"), { busCount: 40 }));
      await assertFails(setDoc(doc(db, "parks/fake"), { name: "Fake park", busCount: 9 }));
      await assertFails(setDoc(doc(db, "config/fleet"), { busSeats: 30 }));
    }
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, "landmarks/gate")));
    await assertFails(getDoc(doc(anon, "parks/shasha")));
    await assertFails(getDoc(doc(anon, "config/fleet")));
  });
});

describe("staff and strangers", () => {
  test("staff without a completed second factor read nothing extra", async () => {
    const noMfa = as("sam", { role: "support", staff: true, firebase: { sign_in_provider: "password" } });
    await assertFails(getDoc(doc(noMfa, "flags/f1")));
    await assertFails(getDoc(doc(noMfa, "wallets/rider_alice")));
    const withMfa = as("sam", { role: "support", staff: true, firebase: { sign_in_provider: "password", sign_in_second_factor: "totp" } });
    await assertSucceeds(getDoc(doc(withMfa, "flags/f1")));
    await assertFails(getDoc(doc(withMfa, "ledgerEntries/e1"))); // books are admin/auditor only
  });

  test("a forged staff claim on a rider account gets nothing (profile must be staff and active)", async () => {
    const forged = as("alice", { role: "admin", staff: true, firebase: { sign_in_second_factor: "phone" } });
    // Alice's live profile says rider, so an admin claim alone opens nothing.
    await assertFails(getDoc(doc(forged, "ledgerEntries/e1")));
    await assertFails(getDoc(doc(forged, "flags/f1")));
  });

  test("signed-out callers read nothing, not even routes", async () => {
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, "routes/r1")));
    await assertFails(getDoc(doc(anon, "config/switches")));
    await assertFails(getDoc(doc(anon, "wallets/rider_alice")));
  });
});

describe("landing-page waitlist", () => {
  const entry = () => ({ role: "student", name: "Ada Okafor", contact: "ada@example.com", source: "landing", createdAt: serverTimestamp() });

  test("anyone can add one well-formed entry", async () => {
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(setDoc(doc(anon, "waitlist/w1"), entry()));
  });

  test("nobody can read, edit or delete entries from a browser", async () => {
    const anon = env.unauthenticatedContext().firestore();
    const alice = env.authenticatedContext("alice", { role: "rider" }).firestore();
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "waitlist/w2"), { ...entry(), createdAt: new Date() }));
    await assertFails(getDoc(doc(anon, "waitlist/w2")));
    await assertFails(getDocs(collection(alice, "waitlist")));
    await assertFails(setDoc(doc(anon, "waitlist/w2"), entry()));
    await assertFails(updateDoc(doc(anon, "waitlist/w2"), { name: "Changed" }));
    await assertFails(deleteDoc(doc(anon, "waitlist/w2")));
  });

  test("odd shapes are refused", async () => {
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(anon, "waitlist/x1"), { ...entry(), role: "admin" }));
    await assertFails(setDoc(doc(anon, "waitlist/x2"), { ...entry(), name: "x".repeat(81) }));
    await assertFails(setDoc(doc(anon, "waitlist/x3"), { ...entry(), contact: "1" }));
    await assertFails(setDoc(doc(anon, "waitlist/x4"), { ...entry(), createdAt: new Date(2020, 0, 1) }));
    await assertFails(setDoc(doc(anon, "waitlist/x5"), { ...entry(), isAdmin: true }));
    const { source: _source, ...noSource } = entry();
    await assertFails(setDoc(doc(anon, "waitlist/x6"), noSource));
  });
});
