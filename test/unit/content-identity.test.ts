import { expect, test } from "bun:test";
import { canonicalJson, sha256 } from "../../src/shared/content-identity";

test("content identities sort object keys without changing array order", () => {
  expect(canonicalJson({ z: [3, 2, 1], a: { y: true, x: "value" } }))
    .toBe('{"a":{"x":"value","y":true},"z":[3,2,1]}');
  expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("content identities reject values JSON cannot represent exactly", () => {
  expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow("non-finite number");
  expect(() => canonicalJson({ value: undefined })).toThrow("non-JSON value");
});
