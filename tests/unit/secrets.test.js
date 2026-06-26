import { describe, it, expect, afterEach, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFileSecrets } from "../../src/config/secrets.js";

const dir = mkdtempSync(join(tmpdir(), "secrets-"));
afterEach(() => {
  delete process.env.TEST_SECRET;
  delete process.env.TEST_SECRET_FILE;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("loadFileSecrets", () => {
  it("reads a secret from *_FILE and trims it", () => {
    const f = join(dir, "s.txt");
    writeFileSync(f, "  super-secret-value\n");
    process.env.TEST_SECRET_FILE = f;
    loadFileSecrets(["TEST_SECRET"]);
    expect(process.env.TEST_SECRET).toBe("super-secret-value");
  });

  it("does not override an already-set env var", () => {
    process.env.TEST_SECRET = "from-env";
    process.env.TEST_SECRET_FILE = join(dir, "ignored.txt");
    writeFileSync(process.env.TEST_SECRET_FILE, "from-file");
    loadFileSecrets(["TEST_SECRET"]);
    expect(process.env.TEST_SECRET).toBe("from-env");
  });

  it("skips a missing file (optional mounted secret key)", () => {
    process.env.TEST_SECRET_FILE = join(dir, "nope.txt");
    expect(() => loadFileSecrets(["TEST_SECRET"])).not.toThrow();
    expect(process.env.TEST_SECRET).toBeUndefined();
  });

  it("is a no-op when neither var is set", () => {
    expect(() => loadFileSecrets(["TEST_SECRET"])).not.toThrow();
    expect(process.env.TEST_SECRET).toBeUndefined();
  });
});
