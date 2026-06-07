import { formatUsd, formatDuration } from "./src/util/format.js";

console.log("formatUsd tests:");
console.log("  0.0023 ->", formatUsd(0.0023));
console.log("  0 ->", formatUsd(0));
console.log("  0.00125 ->", formatUsd(0.00125));
console.log("  NaN ->", formatUsd(NaN));

console.log("\nformatDuration tests:");
console.log("  450 ->", formatDuration(450));
console.log("  0 ->", formatDuration(0));
console.log("  2300 ->", formatDuration(2300));
console.log("  83000 ->", formatDuration(83000));
console.log("  3725000 ->", formatDuration(3725000));
console.log("  -100 ->", formatDuration(-100));
