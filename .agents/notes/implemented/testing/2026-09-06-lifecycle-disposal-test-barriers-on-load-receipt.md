# Agent Note: the lifecycle disposal test barriers on load receipt, not on a sleep

Status: implemented

English | [中文](2026-09-06-lifecycle-disposal-test-barriers-on-load-receipt.zh.md)

## Problem

`stops driving the endpoint once disposed mid-load` failed once under the full suite (`expected 1 to be undefined`) while passing every isolated run. The test disposed the manager after a fixed 40ms sleep, then captured `loadCount` immediately after the disposal rejection resolved. The mock increments its counter at request receipt, so the capture races one specific event: a load POST dispatched just before `dispose()` is already on the wire, and the mock's handler — which owns the increment — runs on the server's own I/O schedule. Under load, that landing lands after the capture: the count reads `undefined`, grows to 1 inside the following settle window, and the equality assertion fires on a request the disposal never caused.

## Decision

The mock router owns request receipt, so it now publishes it: `loadReceived(model)` resolves once at least one load POST for the model has been received and counted (immediately when one already has). The test barriers on that receipt before disposing, and pins the captured count to `1` explicitly. After the barrier the count is stable by construction — the lifecycle issues one load POST per wait, the mock holds the model in `loading` for the whole window so no re-issue path can open, and every fetch the manager could issue after disposal rejects through the scoped abort — so the remaining settle window plus equality assertion guards exactly the regression it claims: a load POST issued after disposal.

The fixed 40ms pre-dispose sleep is gone. It was never a readiness signal: under a quiet host it disposed long after the POST was counted, and under load it disposed mid-dispatch, which is the failure above.

## Alternatives considered

**Capture the count after a longer sleep.** Rejected: it widens the window without naming the awaited state; the same load-induced delay that broke 40ms can break any fixed value.

**Poll the counter until it stops changing, then capture.** Rejected: "unchanged for N ms" is a sleep heuristic wearing a promise's clothes; the mock can state receipt directly.

**Assert on the lifecycle's own issued-request log instead of the server's count.** Deferred: it needs an injection point in `ModelLifecycle` that no other consumer wants; the server-side receipt is the owned, observable signal.

## Verification

Negative control: with `closed.abort` commented out of `dispose()`, the test fails on the `rejects` assertion (no `ABORTED`), so the guard still fires on the regression it exists for. The fixed spec passes 5×23 runs and the package lane passes 3×50 under the same worker topology that flaked; the product source is untouched (revert of the control is byte-identical).

## Consequences

The full-suite topology loses this flake. The barrier also removes a vacuous pass: before, a dispose landing before the first POST exercised nothing; now the test provably disposes with a load in flight.
