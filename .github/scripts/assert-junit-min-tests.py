#!/usr/bin/env python3
"""Assert a JUnit XML report contains at least MIN_TESTS executed test cases.

Why this exists: both of the TypeScript runners in this monorepo exit 0 on an
empty selection. `vitest run` with a glob that matches nothing is a success, and
so is `node --test` with a file list the shell expanded to nothing. A green check
that executed zero tests is worse than no check, because it reads as "verified".
So every suite asserts its own size, and prints the number into the job log where
a reviewer can see it instead of trusting the checkmark.

The floor is a RATCHET, not a target: raise it when tests are added, and lower it
only deliberately, in the same commit that removes the tests.

Counting is done by walking every <testcase> element rather than reading the
`tests=` attribute on the root, because the two runners emit different dialects:

  vitest      <testsuites tests="211"> with one flat <testsuite> per file
  node --test <testsuites> with NO root attributes and NESTED <testsuite>
              elements for describe-blocks

`iter('testcase')` yields each case exactly once under both, and was verified
against the runners' own summaries (66 / 211 / 313) before this was committed.

Usage: assert-junit-min-tests.py <report.xml> <min-tests> [label]
"""

import sys
import xml.etree.ElementTree as ET


def main() -> int:
    if len(sys.argv) < 3:
        sys.exit(f"usage: {sys.argv[0]} <report.xml> <min-tests> [label]")

    report, floor_arg = sys.argv[1], sys.argv[2]
    label = sys.argv[3] if len(sys.argv) > 3 else report
    floor = int(floor_arg)

    try:
        root = ET.parse(report).getroot()
    except FileNotFoundError:
        sys.exit(
            f"FAIL [{label}]: no JUnit report at {report}. The test step either did "
            "not run or the reporter flags were ignored. (Note: `node --test` "
            "silently ignores --test-reporter flags placed AFTER the file list, and "
            "still exits 0.)"
        )
    except ET.ParseError as exc:
        sys.exit(f"FAIL [{label}]: {report} is not parseable JUnit XML: {exc}")

    cases = list(root.iter("testcase"))
    total = len(cases)
    skipped = sum(1 for c in cases if c.find("skipped") is not None)
    failed = sum(
        1 for c in cases if c.find("failure") is not None or c.find("error") is not None
    )

    print(
        f"tests executed [{label}]: {total} "
        f"(failed {failed}, skipped {skipped}, floor {floor})"
    )

    if total < floor:
        sys.exit(
            f"FAIL [{label}]: only {total} tests executed, expected at least {floor}. "
            "Either tests were deleted (lower the floor deliberately, in the same "
            "commit) or collection is silently broken."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
