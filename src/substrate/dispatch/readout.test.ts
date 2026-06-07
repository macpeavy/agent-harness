// Co-located tests for the cheap-able-fraction readout.

import { describe, expect, it } from "bun:test";
import { cheapAbleFraction } from "./readout";
import type { Dispatch } from "./model";

describe("cheapAbleFraction", () => {
  it("empty input → all zeros and empty histogram", () => {
    const result = cheapAbleFraction([]);
    expect(result).toEqual({
      total: 0,
      reachedReady: 0,
      escalated: 0,
      failed: 0,
      inFlight: 0,
      cheapAbleFraction: 0,
      blendedCostPerReadyUsd: 0,
      totalCostUsd: 0,
      amendRoundsHistogram: {},
    });
  });

  it("five dispatches: 2 done, 1 escalated, 1 failed, 1 building → totals and state counts", () => {
    const done1: Dispatch = {
      id: "1",
      issueId: "issue-1",
      title: "Fix bug",
      branch: "fix/bug-1",
      spec: "The spec",
      state: "done",
      route: "cheap",
      buildSessionId: "build-session-1",
      reviewSessionId: "review-session-1",
      prUrl: "https://github.com/foo/pr/1",
      buildCostUsd: 10,
      reviewCostUsd: 5,
      amendCostUsd: 2,
      escalated: null,
      amendRounds: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const done2: Dispatch = {
      id: "2",
      issueId: "issue-2",
      title: "Add feature",
      branch: "feature/add-stuff",
      spec: "The spec",
      state: "done",
      route: "cheap",
      buildSessionId: "build-session-2",
      reviewSessionId: "review-session-2",
      prUrl: "https://github.com/foo/pr/2",
      buildCostUsd: 8,
      reviewCostUsd: 4,
      amendCostUsd: 1,
      escalated: null,
      amendRounds: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const escalated: Dispatch = {
      id: "3",
      issueId: "issue-3",
      title: "Escalated work",
      branch: "escalate/me",
      spec: "The spec",
      state: "escalated",
      route: "expensive",
      buildSessionId: "build-session-3",
      reviewSessionId: "review-session-3",
      prUrl: "https://github.com/foo/pr/3",
      buildCostUsd: 15,
      reviewCostUsd: null,
      amendCostUsd: 3,
      escalated: "tier-promote",
      amendRounds: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const failed: Dispatch = {
      id: "4",
      issueId: "issue-4",
      title: "Failed work",
      branch: "failed/task",
      spec: "The spec",
      state: "failed",
      route: "cheap",
      buildSessionId: "build-session-4",
      reviewSessionId: "review-session-4",
      prUrl: "https://github.com/foo/pr/4",
      buildCostUsd: 20,
      reviewCostUsd: 10,
      amendCostUsd: null,
      escalated: null,
      amendRounds: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const building: Dispatch = {
      id: "5",
      issueId: "issue-5",
      title: "In flight",
      branch: "inflight/task",
      spec: "The spec",
      state: "building",
      route: "cheap",
      buildSessionId: "build-session-5",
      reviewSessionId: "review-session-5",
      prUrl: "https://github.com/foo/pr/5",
      buildCostUsd: 5,
      reviewCostUsd: null,
      amendCostUsd: null,
      escalated: null,
      amendRounds: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = cheapAbleFraction([done1, done2, escalated, failed, building]);
    expect(result.total).toBe(5);
    expect(result.reachedReady).toBe(2);
    expect(result.escalated).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.inFlight).toBe(1);
    expect(result.cheapAbleFraction).toBe(0.5); // 2 ready / 4 terminal
    expect(result.totalCostUsd).toBe(83); // All costs summed: 17+13+18+30+5
    expect(result.blendedCostPerReadyUsd).toBeCloseTo(83 / 2); // totalCost / reachedReady
    expect(result.amendRoundsHistogram).toEqual({ 0: 4, 1: 1 }); // 4 with 0 rounds, 1 with 1 round
  });

  it("null costs are counted as 0", () => {
    const dispatch: Dispatch = {
      id: "1",
      issueId: "issue-1",
      title: "Work with nulls",
      branch: "null/task",
      spec: "The spec",
      state: "done",
      route: "cheap",
      buildSessionId: "build-session-1",
      reviewSessionId: "review-session-1",
      prUrl: "https://github.com/foo/pr/1",
      buildCostUsd: null,
      reviewCostUsd: null,
      amendCostUsd: null,
      escalated: null,
      amendRounds: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = cheapAbleFraction([dispatch]);
    expect(result.totalCostUsd).toBe(0);
    expect(result.blendedCostPerReadyUsd).toBe(0);
  });

  it("amendRoundsHistogram includes each encountered value once", () => {
    const d1: Dispatch = {
      id: "1",
      issueId: "issue-1",
      title: "First",
      branch: "amend/1",
      spec: "The spec",
      state: "done",
      route: "cheap",
      buildSessionId: "build-session-1",
      reviewSessionId: "review-session-1",
      prUrl: "https://github.com/foo/pr/1",
      buildCostUsd: 1,
      reviewCostUsd: 1,
      amendCostUsd: 1,
      escalated: null,
      amendRounds: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const d2: Dispatch = {
      id: "2",
      issueId: "issue-2",
      title: "Second",
      branch: "amend/2",
      spec: "The spec",
      state: "done",
      route: "cheap",
      buildSessionId: "build-session-2",
      reviewSessionId: "review-session-2",
      prUrl: "https://github.com/foo/pr/2",
      buildCostUsd: 1,
      reviewCostUsd: 1,
      amendCostUsd: 1,
      escalated: null,
      amendRounds: 2,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const d3: Dispatch = {
      id: "3",
      issueId: "issue-3",
      title: "Third",
      branch: "amend/3",
      spec: "The spec",
      state: "building",
      route: "cheap",
      buildSessionId: "build-session-3",
      reviewSessionId: "review-session-3",
      prUrl: "https://github.com/foo/pr/3",
      buildCostUsd: 1,
      reviewCostUsd: 1,
      amendCostUsd: 1,
      escalated: null,
      amendRounds: 3,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = cheapAbleFraction([d1, d2, d3]);
    expect(result.amendRoundsHistogram).toEqual({ 0: 1, 2: 1, 3: 1 });
  });

  it("cheapAbleFraction is 0 when terminalCount is 0", () => {
    const inFlight1: Dispatch = {
      id: "1",
      issueId: "issue-1",
      title: "Queued",
      branch: "queue/task",
      spec: "The spec",
      state: "queued",
      route: "cheap",
      buildSessionId: "build-session-1",
      reviewSessionId: "review-session-1",
      prUrl: "https://github.com/foo/pr/1",
      buildCostUsd: 1,
      reviewCostUsd: 1,
      amendCostUsd: 1,
      escalated: null,
      amendRounds: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const inFlight2: Dispatch = {
      id: "2",
      issueId: "issue-2",
      title: "Reviewing",
      branch: "review/task",
      spec: "The spec",
      state: "review",
      route: "cheap",
      buildSessionId: "build-session-2",
      reviewSessionId: "review-session-2",
      prUrl: "https://github.com/foo/pr/2",
      buildCostUsd: 1,
      reviewCostUsd: 1,
      amendCostUsd: 1,
      escalated: null,
      amendRounds: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = cheapAbleFraction([inFlight1, inFlight2]);
    expect(result.cheapAbleFraction).toBe(0);
    expect(result.blendedCostPerReadyUsd).toBe(0);
    expect(result.reachedReady).toBe(0);
  });

  it("blendedCostPerReadyUsd is 0 when reachedReady is 0", () => {
    const failedDispatch: Dispatch = {
      id: "1",
      issueId: "issue-1",
      title: "Failed",
      branch: "fail/task",
      spec: "The spec",
      state: "failed",
      route: "cheap",
      buildSessionId: "build-session-1",
      reviewSessionId: "review-session-1",
      prUrl: "https://github.com/foo/pr/1",
      buildCostUsd: 100,
      reviewCostUsd: 50,
      amendCostUsd: 25,
      escalated: null,
      amendRounds: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = cheapAbleFraction([failedDispatch]);
    expect(result.reachedReady).toBe(0);
    expect(result.blendedCostPerReadyUsd).toBe(0);
    expect(result.totalCostUsd).toBe(175);
  });
});
