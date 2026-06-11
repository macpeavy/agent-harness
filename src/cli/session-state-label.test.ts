import { describe, expect, it } from "bun:test";
import { sessionStateLabel } from "./session-state-label";

describe("sessionStateLabel", () => {
  it("renders review as awaiting the OWNER — the ambiguity the first run hit", () => {
    expect(sessionStateLabel("review")).toBe("awaiting your review");
  });

  it("renders needs-attention as stuck", () => {
    expect(sessionStateLabel("needs-attention")).toBe("stuck — chief routing");
  });

  it("passes unambiguous states through unchanged", () => {
    expect(sessionStateLabel("building")).toBe("building");
    expect(sessionStateLabel("done")).toBe("done");
    expect(sessionStateLabel("planning")).toBe("planning");
  });
});
