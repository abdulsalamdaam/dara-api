/**
 * CSR field sanitisation.
 *
 * Every one of these values is substituted into an openssl CONFIG file, not
 * into a string literal — so they are config syntax, and openssl reads them as
 * such. That makes an unescaped value an injection into the document that
 * defines the seller's certificate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { csrField } from "./csr.service";

test("a newline cannot add a directive to the certificate subject", () => {
  // `\n` ends the value and starts a new key = value line, so this used to add
  // an emailAddress to the subject — and the same trick with `[ req_ext ]`
  // replaced the whole subjectAltName block, which is what identifies the EGS
  // unit to ZATCA.
  assert.throws(() => csrField("organizationUnitName", "300000000000003\nemailAddress = evil@x.com"), /سطر جديد/);
  assert.throws(() => csrField("serialNumber", "1-Dara|2-PMS|3-1\r\n[ req_ext ]\nsubjectAltName = dirName:evil"), /سطر جديد/);
});

test("a CSR field cannot read the server's environment", () => {
  // openssl expands $ENV::NAME in config values. This one is not corruption,
  // it is exfiltration: the onboarding endpoint hands the resulting subject
  // straight back, and it is embedded in every invoice's signature afterwards.
  assert.throws(() => csrField("organizationName", "$ENV::APP_ENCRYPTION_KEY"), /\$/);
  assert.throws(() => csrField("organizationName", "$ENV::DATABASE_URL"), /\$/);
  // Refused wherever it appears, not only in the $ENV:: form — `$` also
  // introduces openssl's own variable references, and `$&` separately mangles
  // the template substitution.
  assert.throws(() => csrField("sellerName", "A$&B"), /\$/);
});

test("an over-long or empty value is refused here, not by ZATCA", () => {
  // X.520 bounds these; openssl enforces nothing, so an over-long value is
  // rejected at ZATCA with a message that names nothing.
  assert.throws(() => csrField("commonName", "x".repeat(65)), /64/);
  assert.throws(() => csrField("commonName", ""), /مطلوبة/);
  assert.throws(() => csrField("commonName", "   "), /مطلوبة/);
});

test("legitimate values still pass, Arabic and pipe-delimited serials included", () => {
  // The guard must not break the two shapes this system actually uses: ZATCA's
  // own pipe-delimited EGS serial, and an Arabic seller name (the certificate
  // subject is UTF-8 precisely so these work).
  assert.equal(csrField("serialNumber", "1-Dara|2-PMS|3-264-2"), "1-Dara|2-PMS|3-264-2");
  assert.equal(csrField("sellerName", "ابراهيم العقيل"), "ابراهيم العقيل");
  assert.equal(csrField("commonName", "Dara-264"), "Dara-264");
  assert.equal(csrField("countryName", "  SA  "), "SA", "trimmed, not rejected");
});

test("Arabic is allowed in the subject and refused in the SAN", () => {
  // Not an arbitrary distinction: `utf8 = yes` governs the subject, and the
  // dirName section is parsed as Latin-1 no matter what, so Arabic there is
  // double-encoded and then silently truncated away. Refusing is the only way
  // the user finds out at all.
  assert.equal(csrField("organizationName", "ابراهيم العقيل"), "ابراهيم العقيل");
  assert.throws(() => csrField("locationAddress", "1190, طريق الملك فهد, الدمام"), /لاتينية/);
  assert.throws(() => csrField("industryCategory", "عقارات"), /لاتينية/);
  // The ASCII rendering the onboarding screen sends instead.
  assert.equal(csrField("locationAddress", "6802 32272 SA"), "6802 32272 SA");
});

test("every ZATCA-mandated SAN attribute survives a real seller", async () => {
  // The regression this exists for is silent. openssl parses the dirName
  // section as Latin-1 whatever `utf8 = yes` says, and past ~40 doubled bytes
  // it abandons the attribute, drops it AND everything after it, and exits 0.
  // A Riyadh street name therefore produced a certificate with no
  // registeredAddress and no businessCategory, and nothing in our stack knew.
  const { CsrService } = await import("./csr.service");
  const { ShellService } = await import("./shell.service");
  const svc = new CsrService(new ShellService());
  const r = await svc.generateCsr({
    environment: "production",
    commonName: "Dara-264",
    serialNumber: "1-Dara|2-PMS|3-264-2",
    organizationIdentifier: "310404305800003",
    organizationUnitName: "1037898051",
    // Arabic in the SUBJECT is fine — that half is genuinely UTF-8.
    organizationName: "ابراهيم العقيل",
    countryName: "SA",
    invoiceType: "1100",
    locationAddress: "6802 32272 SA",
    industryCategory: "Real estate",
  });
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const f = path.join(os.tmpdir(), `zatca-csr-spec-${process.pid}.csr`);
  fs.writeFileSync(f, r.csr);
  try {
    const text = execFileSync("openssl", ["req", "-in", f, "-noout", "-text"]).toString();
    for (const attr of ["SN=", "UID=", "title=", "registeredAddress=", "businessCategory="]) {
      assert.ok(text.includes(attr), `${attr} missing from the SAN — openssl dropped it`);
    }
    // And the subject keeps its Arabic single-encoded, not as "Ø§Ø¨Ø±Ø§Ù‡ÙŠÙ…".
    assert.ok(text.includes("ابراهيم العقيل"), "the seller name was re-encoded");
  } finally {
    fs.unlinkSync(f);
  }
});
