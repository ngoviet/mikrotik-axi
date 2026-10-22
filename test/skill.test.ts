import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderSkill } from "../src/skill.js";

describe("skill/SKILL.md", () => {
  it("matches the generated content (run `pnpm skill:build` after changing commands or alerts)", () => {
    expect(readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8")).toBe(renderSkill());
  });
});
