---
applyTo: "**"
excludeAgent: "cloud-agent"
---

# Pull request review

Review only the changed files and hunks. Prioritize correctness, security, and
behavioral regressions. Do not report formatting, style, or speculative issues.

## Behavioral pass

Perform this pass before general TypeScript or Electron checks.

1. For every changed condition, describe the old and new accepted inputs and
   verify that the new set matches the stated intent.
2. Verify guards accept every case handled below them and reject unsupported
   cases.
3. Verify producers and consumers agree on events, actions, queue entries,
   discriminated unions, and persisted values.
4. Treat main-to-renderer IPC as one contract: channel names and payload shapes
   must match on both sides.
5. Trace removed branches and new early exits. Report inputs that are now
   ignored, dropped, or routed to an unintended fallback.
6. Check nearby comments and types that state invariants such as ordering,
   required calls, ranges, or units.

## General pass

Check changed code for:

- unhandled promise rejections, races, and incorrect async sequencing
- unsafe casts, unjustified `any`, and unchecked nullable values
- missing error and empty-input handling
- main/renderer/shared module-boundary violations
- secrets, credentials, payment data, or government identifiers in code or logs
- entire request, response, or user objects being logged
- metric tags containing IDs, timestamps, URLs, hashes, or other high-cardinality values
- behavior changes without focused regression coverage

## Findings

Report only actionable findings. For each finding:

- cite the changed file and new-side line
- quote the relevant code
- explain the concrete failure mode in this repository
- provide a minimal corrected snippet
- classify it as `critical`, `important`, or `suggestion`

Use `critical` for security issues, IPC mismatches, inverted guards, silently
dropped inputs, or unintended changes to accepted, emitted, persisted, or
routed values. Use `important` for correctness, race, error-handling, and
performance problems. Keep suggestions rare.

If no actionable issues exist, say so plainly. Reviews are advisory; never
approve or block a pull request.
