# Format Utilities

This module provides display formatting utilities for currency values and durations.

## Exports

### `formatUsd(amount: number): string`
Formats a number as a USD amount with a leading dollar sign and 4 decimal places.

#### Usage
```typescript
import { formatUsd } from "./format";

// Positive numbers
formatUsd(0.0023);  // "$0.0023"
formatUsd(123.456); // "$123.4560"

// Special cases
formatUsd(NaN);     // "$0.0000"
formatUsd(Infinity); // "$0.0000"
formatUsd(-100);    // "$0.0000"
```

### `formatDuration(ms: number): string`
Formats milliseconds as a human-readable compact duration string.

#### Usage
```typescript
import { formatDuration } from "./format";

// Milliseconds
formatDuration(450);          // "450ms"
formatDuration(999);          // "999ms"

// Seconds
formatDuration(1000);         // "1.0s"
formatDuration(2300);         // "2.3s"
formatDuration(59999);        // "60.0s"

// Minutes and seconds
formatDuration(60000);        // "1m 0s"
formatDuration(83000);        // "1m 23s"
formatDuration(3599000);      // "59m 59s"

// Hours and minutes
formatDuration(3600000);      // "1h 0m"
formatDuration(3725000);      // "1h 2m"

// Special cases
formatDuration(NaN);          // "0ms"
formatDuration(Infinity);     // "0ms"
formatDuration(-1000);        // "0ms"
formatDuration(Number.MAX_SAFE_INTEGER); // "2501999792h 59m"
```

## Testing

Run tests with:
```bash
bun test src/util/format.test.ts
```

## Notes

- Both functions are safe with non-finite inputs (NaN, Infinity, -Infinity)
- Negative values for `formatUsd` return "$0.0000"
- Negative values for `formatDuration` return "0ms"
