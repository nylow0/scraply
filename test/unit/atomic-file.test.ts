import { describe, expect, test } from "bun:test";
import { writeFileAtomically } from "../../src/main/atomic-file";

describe("atomic encrypted-file replacement", () => {
  test("retains the previous file and removes the encrypted temporary when replacement fails", () => {
    const files = new Map<string, Uint8Array>([["secrets.bin", Buffer.from("previous-encrypted-bytes")]]);
    let temporaryPath = "";

    expect(() => writeFileAtomically("secrets.bin", Buffer.from("next-encrypted-bytes"), {
      write(path, contents) {
        temporaryPath = path;
        files.set(path, contents);
      },
      replace() { throw new Error("simulated interrupted replacement"); },
      remove(path) { files.delete(path); },
    })).toThrow("simulated interrupted replacement");

    expect(Buffer.from(files.get("secrets.bin")!).toString()).toBe("previous-encrypted-bytes");
    expect(files.has(temporaryPath)).toBe(false);
  });
});
