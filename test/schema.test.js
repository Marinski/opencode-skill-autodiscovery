import test from "node:test";
import assert from "node:assert/strict";
import { validateName } from "../dist/schema.js";

test("validateName: accepts typical valid identifiers", () => {
  for (const name of ["a", "lint3r", "my-plugin", "acme.tools"]) {
    assert.equal(validateName(name), name, `expected "${name}" to be accepted`);
  }
});

test("validateName: rejects prototype keys, traversal, empty, blank, control chars", () => {
  const invalid = [
    "__proto__",
    "constructor",
    "../../etc",
    "",
    "   ",
    "bad\u0000name",
    "bad\u001bname",
  ];
  for (const name of invalid) {
    assert.equal(validateName(name), null, `expected "${name}" to be rejected`);
  }
});
