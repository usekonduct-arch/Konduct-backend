import { test } from "node:test";
import assert from "node:assert/strict";

import { codeHash, emailKey, maskEmail, normalizeStudentId, studentIdKey } from "./identity";
import { hashPin, isPinShape, isWeakPin, verifyPin } from "./pin";

test("student IDs typed differently collapse to one key", () => {
  const forms = ["UNI/2023/04571", "uni/2023/04571", " UNI-2023-04571 ", "UNI 2023 04571", "UNI//2023/04571/"];
  const keys = new Set(forms.map(normalizeStudentId));
  assert.deepEqual([...keys], ["UNI-2023-04571"]);
  assert.equal(studentIdKey("uniosun", "UNI-2023-04571"), "uniosun__UNI-2023-04571");
});

test("PIN shape and weak PINs match the app", () => {
  assert.ok(isPinShape("2580") && isPinShape("204816"));
  assert.ok(!isPinShape("12345") && !isPinShape("12a4"));
  for (const p of ["1111", "1234", "9876", "123456", "000000"]) assert.ok(isWeakPin(p), p);
  for (const p of ["2580", "1379", "204816"]) assert.ok(!isWeakPin(p), p);
});

test("PIN hashes verify, use a fresh salt, and reject wrong PINs", async () => {
  const a = await hashPin("2580");
  const b = await hashPin("2580");
  assert.notEqual(a.hash, b.hash);
  assert.ok(await verifyPin("2580", a));
  assert.ok(!(await verifyPin("2581", a)));
});

test("emails are keyed case-insensitively and masked for admin lists", () => {
  assert.equal(emailKey(" Tunde@Gmail.com "), emailKey("tunde@gmail.com"));
  assert.notEqual(emailKey("tunde@gmail.com"), emailKey("tunde2@gmail.com"));
  assert.equal(maskEmail("Adaeze.Okafor@uniosun.edu.ng"), "ad***@uniosun.edu.ng");
  assert.equal(maskEmail("not-an-email"), "***");
});

test("onboarding codes are stored as keyed hashes, case-insensitively", () => {
  assert.equal(codeHash("kd7f3q2x", "k"), codeHash("KD7F3Q2X", "k"));
  assert.notEqual(codeHash("KD7F3Q2X", "k"), codeHash("KD7F3Q2X", "other-key"));
  assert.ok(!codeHash("KD7F3Q2X", "k").includes("KD7F3Q2X"));
});
