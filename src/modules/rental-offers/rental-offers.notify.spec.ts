import { test } from "node:test";
import assert from "node:assert/strict";
import { landlordOfferEvent, landlordOfferMessage } from "./rental-offers.notify";

test("landlord hears of an offer only once it leaves draft", () => {
  assert.equal(landlordOfferEvent(null, "draft"), null);
  assert.equal(landlordOfferEvent(null, "sent"), "submitted");
  assert.equal(landlordOfferEvent("draft", "sent"), "submitted");
  assert.equal(landlordOfferEvent("draft", "accepted"), "accepted");
});

test("status changes on a visible offer", () => {
  assert.equal(landlordOfferEvent("sent", "accepted"), "accepted");
  assert.equal(landlordOfferEvent("sent", "rejected"), "rejected");
  assert.equal(landlordOfferEvent("sent", "cancelled"), "cancelled");
  assert.equal(landlordOfferEvent("rejected", "sent"), "reopened");
  assert.equal(landlordOfferEvent("sent", "sent"), null);
  assert.equal(landlordOfferEvent("accepted", "draft"), null);
});

test("message names the offer, client and unit", () => {
  const m = landlordOfferMessage("submitted", { number: "RO-2026-0002", clientName: "شركة", unitLabel: "شقة 22" });
  assert.equal(m.title, "عرض تأجير جديد");
  assert.match(m.body, /RO-2026-0002/);
  assert.match(m.body, /شقة 22/);
});
