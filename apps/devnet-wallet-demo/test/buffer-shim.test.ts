import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Buffer } from "../src/buffer-shim.ts";

describe("wallet demo browser Buffer compatibility", () => {
  it("supports the base64, concatenation, and hex operations used by guard-client", () => {
    const decoded = Buffer.from("AAECA/8=", "base64");
    assert.deepEqual([...decoded], [0, 1, 2, 3, 255]);
    assert.equal(Buffer.concat([decoded.subarray(0, 2), decoded.subarray(2)]).toString("hex"), "00010203ff");
  });
});
