import assert from "node:assert/strict";
import test from "node:test";

import { timestampedLine, withTimestamps } from "../src/diagnostic-log.mjs";

test("appends the instant, and leaves the fixed token at the start of the line", () => {
  const line = timestampedLine(
    "popup_issued target=terminal provider=claude reason=finished",
    new Date("2026-08-13T08:41:02.113Z"),
  );
  assert.equal(
    line,
    "popup_issued target=terminal provider=claude reason=finished t=2026-08-13T08:41:02.113Z",
  );
  assert.ok(line.startsWith("popup_issued target=terminal provider=claude "));
});

test("the stamp discloses an instant and nothing else", () => {
  // The channel's content rule is unchanged by this feature: no path, prompt,
  // reply, terminal name, thread id or process id may enter a diagnostic line.
  const line = timestampedLine("signal_accepted provider=claude target=terminal reason=finished",
    new Date("2026-08-13T08:41:02.113Z"));
  const stamp = line.slice(line.indexOf(" t=") + 3);
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("wraps a channel so each line is stamped when it is written, not when it is read", () => {
  const written = [];
  const instants = [
    new Date("2026-08-13T08:41:02.000Z"),
    new Date("2026-08-13T08:41:59.500Z"),
  ];
  let call = 0;
  const channel = withTimestamps({ appendLine: (value) => written.push(value) }, () => instants[call++]);

  channel.appendLine("signal_accepted provider=claude target=terminal reason=finished");
  channel.appendLine("popup_issued target=terminal provider=claude reason=finished");

  assert.deepEqual(written, [
    "signal_accepted provider=claude target=terminal reason=finished t=2026-08-13T08:41:02.000Z",
    "popup_issued target=terminal provider=claude reason=finished t=2026-08-13T08:41:59.500Z",
  ]);
  // The pair above is the measurement the attended run could not make: 57.5s
  // between the signal being accepted and the popup being raised.
});
