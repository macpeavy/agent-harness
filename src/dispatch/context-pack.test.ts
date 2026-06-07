import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextPack, skillsForSurface } from "./context-pack";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ah-pack-"));
  mkdirSync(join(repo, "docs", "skills"), { recursive: true });
  writeFileSync(join(repo, "docs", "standards.md"), "STANDARDS BODY");
  for (const s of ["writing-tests", "persistence-drizzle", "adding-a-substrate-module", "typed-api-boundary"])
    writeFileSync(join(repo, "docs", "skills", `${s}.md`), `SKILL ${s}`);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("skillsForSurface", () => {
  it("always includes writing-tests", () => {
    expect(skillsForSurface("src/util/foo.ts")).toContain("writing-tests");
  });

  it("adds persistence-drizzle for a schema file", () => {
    expect(skillsForSurface("src/substrate/plan/schema.ts")).toEqual(
      expect.arrayContaining(["writing-tests", "persistence-drizzle", "adding-a-substrate-module"]),
    );
  });

  it("adds typed-api-boundary for an opencode module", () => {
    expect(skillsForSurface("src/opencode/client.ts")).toContain("typed-api-boundary");
  });
});

describe("buildContextPack", () => {
  it("injects the standards and the surface-implied skills", () => {
    const pack = buildContextPack({ repoPath: repo, surface: "src/substrate/plan/schema.ts" });
    expect(pack).toContain("STANDARDS BODY");
    expect(pack).toContain("SKILL persistence-drizzle");
    expect(pack).toContain("SKILL writing-tests");
    expect(pack).toContain("SKILL adding-a-substrate-module");
    expect(pack).not.toContain("SKILL typed-api-boundary"); // not implied by this surface
  });

  it("honors an explicit skills override over surface inference", () => {
    const pack = buildContextPack({ repoPath: repo, surface: "src/x.ts", skills: ["typed-api-boundary"] });
    expect(pack).toContain("SKILL typed-api-boundary");
    expect(pack).not.toContain("SKILL adding-a-substrate-module");
  });

  it("defaults to standards + writing-tests with no surface", () => {
    const pack = buildContextPack({ repoPath: repo });
    expect(pack).toContain("STANDARDS BODY");
    expect(pack).toContain("SKILL writing-tests");
  });

  it("skips missing docs without throwing (best-effort)", () => {
    const bare = mkdtempSync(join(tmpdir(), "ah-bare-"));
    try {
      expect(buildContextPack({ repoPath: bare })).toBe(""); // no docs/ → empty pack
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
