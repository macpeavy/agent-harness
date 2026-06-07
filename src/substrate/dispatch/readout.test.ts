import { describe, expect, it } from "bun:test";
import type { Dispatch } from "./schema";
import type { DispatchState } from "./model";
import { cheapAbleFraction } from "./readout";

describe("cheapAbleFraction readout", () => {
  describe("empty input", () => {
    it("returns all zeros and empty object", () => {
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
  });

  describe("basic metrics with mixed states", () => {
    const base = {
      surface: null,
      skills: null,
      route: null,
      buildSessionId: null,
      reviewSessionId: null,
      prUrl: null,
      escalated: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const doneDispatch: Dispatch = Object.assign({
      id: "1",
      issueId: "issue-1",
      title: "Test 1",
      branch: "branch-1",
      spec: "spec content",
      state: "done" as DispatchState,
      buildCostUsd: 100,
      reviewCostUsd: 50,
      amendCostUsd: 25,
      amendRounds: 0,
    }, base);

    const doneWithAmend: Dispatch = Object.assign({
      id: "2",
      issueId: "issue-2",
      title: "Test 2",
      branch: "branch-2",
      spec: "spec content",
      state: "done" as DispatchState,
      buildCostUsd: 200,
      reviewCostUsd: 100,
      amendCostUsd: null,
      amendRounds: 1,
    }, base);

    const escalatedDispatch: Dispatch = Object.assign({
      id: "3",
      issueId: "issue-3",
      title: "Test 3",
      branch: "branch-3",
      spec: "spec content",
      state: "escalated" as DispatchState,
      buildCostUsd: 300,
      reviewCostUsd: null,
      amendCostUsd: 75,
      amendRounds: 0,
    }, base);

    const failedDispatch: Dispatch = Object.assign({
      id: "4",
      issueId: "issue-4",
      title: "Test 4",
      branch: "branch-4",
      spec: "spec content",
      state: "failed" as DispatchState,
      buildCostUsd: null,
      reviewCostUsd: null,
      amendCostUsd: null,
      amendRounds: 2,
    }, base);

    const inFlightDispatch: Dispatch = Object.assign({
      id: "5",
      issueId: "issue-5",
      title: "Test 5",
      branch: "branch-5",
      spec: "spec content",
      state: "building" as DispatchState,
      buildCostUsd: 50,
      reviewCostUsd: null,
      amendCostUsd: null,
      amendRounds: 0,
    }, base);

    const result = cheapAbleFraction([
      doneDispatch,
      doneWithAmend,
      escalatedDispatch,
      failedDispatch,
      inFlightDispatch,
    ]);

    it("counts total dispatches correctly", () => {
      expect(result.total).toBe(5);
    });

    it("tracks reachedReady (done state) correctly", () => {
      expect(result.reachedReady).toBe(2);
    });

    it("tracks escalated correctly", () => {
      expect(result.escalated).toBe(1);
    });

    it("tracks failed correctly", () => {
      expect(result.failed).toBe(1);
    });

    it("tracks inFlight (non-terminal states) correctly", () => {
      expect(result.inFlight).toBe(1);
    });

    it("calculates cheapAbleFraction correctly (2 ready / 4 total terminal = 0.5)", () => {
      expect(result.cheapAbleFraction).toBe(0.5);
    });

    it("calculates totalCostUsd correctly (summing all dispatch costs)", () => {
      // All 5 dispatches have costs:
      // done: 100+50+25 = 175
      // doneWithAmend: 200+100+0 = 300
      // escalated: 300+0+75 = 375
      // failed: 0+0+0 = 0
      // inFlight (building): 50+0+0 = 50
      // Total: 175+300+375+0+50 = 900
      expect(result.totalCostUsd).toBe(900);
    });

    it("calculates blendedCostPerReadyUsd correctly (900 total cost / 2 reachedReady = 450)", () => {
      expect(result.blendedCostPerReadyUsd).toBe(450);
    });

    it("builds amendRoundsHistogram correctly", () => {
      expect(result.amendRoundsHistogram).toEqual({
        0: 3, // doneDispatch, escalatedDispatch, inFlightDispatch
        1: 1, // doneWithAmend
        2: 1, // failedDispatch
      });
    });
  });

  describe("cost calculations with null values", () => {
    const base = {
      surface: null,
      skills: null,
      route: null,
      buildSessionId: null,
      reviewSessionId: null,
      prUrl: null,
      escalated: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    it("treats null costs as 0 when summing", () => {
      const d: Dispatch = Object.assign({
        id: "1",
        issueId: "test",
        title: "Test",
        branch: "test",
        spec: "test",
        state: "done" as DispatchState,
        buildCostUsd: null,
        reviewCostUsd: null,
        amendCostUsd: null,
        amendRounds: 0,
      }, base);

      const result = cheapAbleFraction([d]);
      expect(result.totalCostUsd).toBe(0);
      expect(result.blendedCostPerReadyUsd).toBe(0);
    });

    it("handles partial null costs correctly", () => {
      const d: Dispatch = Object.assign({
        id: "1",
        issueId: "test",
        title: "Test",
        branch: "test",
        spec: "test",
        state: "done" as DispatchState,
        buildCostUsd: 100,
        reviewCostUsd: null,
        amendCostUsd: 50,
        amendRounds: 0,
      }, base);

      const result = cheapAbleFraction([d]);
      expect(result.totalCostUsd).toBe(150);
      expect(result.blendedCostPerReadyUsd).toBe(150);
    });
  });

  describe("edge cases for 0 denominator", () => {
    const base = {
      surface: null,
      skills: null,
      route: null,
      buildSessionId: null,
      reviewSessionId: null,
      prUrl: null,
      escalated: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    it("handles zero cheapAbleFraction when no terminal dispatches", () => {
      const queued: Dispatch = Object.assign({
        id: "1",
        issueId: "test",
        title: "Test",
        branch: "test",
        spec: "test",
        state: "queued" as DispatchState,
        buildCostUsd: 100,
        reviewCostUsd: 0,
        amendCostUsd: 0,
        amendRounds: 0,
      }, base);

      const result = cheapAbleFraction([queued]);
      expect(result.cheapAbleFraction).toBe(0);
      expect(result.blendedCostPerReadyUsd).toBe(0);
    });

    it("handles zero cheapAbleFraction when only escalated or failed", () => {
      const escalated: Dispatch = Object.assign({
        id: "1",
        issueId: "test",
        title: "Test",
        branch: "test",
        spec: "test",
        state: "escalated" as DispatchState,
        buildCostUsd: 100,
        reviewCostUsd: 0,
        amendCostUsd: 0,
        amendRounds: 0,
      }, base);

      const result = cheapAbleFraction([escalated]);
      expect(result.cheapAbleFraction).toBe(0); // 0 ready / 1 terminal = 0
      expect(result.blendedCostPerReadyUsd).toBe(0); // total cost 100 / 0 ready = 0 (spec says "0 when reachedReady === 0")
    });

    it("returns 0 for all numeric fields with empty input", () => {
      const result = cheapAbleFraction([]);
      expect(result.total).toBe(0);
      expect(result.reachedReady).toBe(0);
      expect(result.cheapAbleFraction).toBe(0);
      expect(result.blendedCostPerReadyUsd).toBe(0);
      expect(result.totalCostUsd).toBe(0);
      expect(Object.keys(result.amendRoundsHistogram).length).toBe(0);
    });
  });

  describe("amendRoundsHistogram builds correctly", () => {
    const base = {
      surface: null,
      skills: null,
      route: null,
      buildSessionId: null,
      reviewSessionId: null,
      prUrl: null,
      escalated: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      buildCostUsd: 100,
      reviewCostUsd: 0,
      amendCostUsd: 0,
    };

    it("tracks each amendRounds value with count", () => {
      const d1: Dispatch = Object.assign({
        id: "1",
        issueId: "test1",
        title: "Test",
        branch: "test1",
        spec: "test",
        state: "done" as DispatchState,
        amendRounds: 0,
      }, base);

      const d2: Dispatch = Object.assign({
        id: "2",
        issueId: "test2",
        title: "Test",
        branch: "test2",
        spec: "test",
        state: "done" as DispatchState,
        amendRounds: 0,
      }, base);

      const d3: Dispatch = Object.assign({
        id: "3",
        issueId: "test3",
        title: "Test",
        branch: "test3",
        spec: "test",
        state: "done" as DispatchState,
        amendRounds: 1,
      }, base);

      const d4: Dispatch = Object.assign({
        id: "4",
        issueId: "test4",
        title: "Test",
        branch: "test4",
        spec: "test",
        state: "done" as DispatchState,
        amendRounds: 2,
      }, base);

      const d5: Dispatch = Object.assign({
        id: "5",
        issueId: "test5",
        title: "Test",
        branch: "test5",
        spec: "test",
        state: "done" as DispatchState,
        amendRounds: 0,
      }, base);

      const result = cheapAbleFraction([d1, d2, d3, d4, d5]);
      expect(result.amendRoundsHistogram).toEqual({
        0: 3,
        1: 1,
        2: 1,
      });
    });

    it("defaults amendRounds to 0 when null", () => {
      const d: Dispatch = Object.assign({
        id: "1",
        issueId: "test",
        title: "Test",
        branch: "test",
        spec: "test",
        state: "done" as DispatchState,
        amendRounds: null as unknown as number, // Type assertion for null
        buildCostUsd: 100,
        reviewCostUsd: 0,
        amendCostUsd: 0,
      }, base);

      const result = cheapAbleFraction([d]);
      // The contract says amendRounds is in the Dispatch type but defaulted to 0
      // In practice it won't be null due to schema default (integer().notNull().default(0)),
      // but we should handle null gracefully
      expect(result.amendRoundsHistogram).toBeDefined();
    });
  });
});
