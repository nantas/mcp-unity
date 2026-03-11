# Unity FIFO / Job Model Evaluation

## Context

The current phase-1 design has now passed host-project validation in `/Volumes/Shuttle/unity-projects/neonnew` through the authoritative runtime path: interactive `codex` started inside the host repo.

Verified baseline:

- multi-client coexistence is stable
- single-writer admission works
- conflicting writes return `busy_error`
- targeted EditMode validation passed in the host project
- no additional source changes were required during the latest host validation pass

This changes the question from "what is needed to make the package usable" to "what is worth building next".

## Current Problem Statement

The remaining architectural gap is not a blocker. It is a product and workflow question:

- should `mcp-unity` stay with the current `multi-client + single-writer + busy_error` model for now
- or should it move to a Unity-side global FIFO queue or a fuller job model

The answer should be based on actual workflow pressure, not on architecture purity alone.

## Options

### Option A: Keep the current busy-error model for now

Behavior:

- multiple clients can stay connected
- reads continue directly
- only one write runs at a time
- overlapping writes fail fast with `busy_error`

Benefits:

- already validated in the real host project
- smallest maintenance cost
- failure mode is explicit and easy to reason about
- preserves synchronous MCP request/response semantics

Costs:

- callers must retry manually after `busy_error`
- no fairness guarantee between competing clients
- no queue visibility

Assessment:

- best default if current team usage is mostly one active writer plus occasional contention

### Option B: Add a Unity-side global FIFO queue while keeping synchronous external semantics

Behavior:

- writes enter a Unity-owned queue
- execution remains serial on the Unity main thread
- the caller still waits synchronously for completion

Benefits:

- fairer execution ordering
- removes immediate retry pressure from clients
- better fit if multiple agents are expected to issue writes frequently

Costs:

- request timeout behavior becomes more complex
- disconnect handling becomes ambiguous while a job is queued
- partial queue semantics can create a "hidden job model" without explicit tooling

Assessment:

- only worth doing if `busy_error` becomes a frequent workflow problem in real usage

### Option C: Move to an explicit job model

Behavior:

- clients submit jobs and poll or fetch results later
- queue state and execution state become first-class protocol concepts

Benefits:

- the cleanest long-term model
- supports queue inspection, retries, cancellation, and disconnect recovery
- scales better to long-running Unity operations

Costs:

- largest protocol and client-surface change
- changes current synchronous user experience
- higher implementation and migration cost

Assessment:

- correct long-term direction if the project later needs real automation throughput, unattended workflows, or reliable long-running orchestration

## Recommendation

Recommend **Option A for the next development stage**, with Option C kept as the long-term direction.

Reasoning:

- the validated host-project workflow is already good enough for real development
- no current evidence shows that `busy_error` is blocking actual daily usage
- adding FIFO now would increase complexity before there is proof of need
- if the team later outgrows `busy_error`, it is better to jump intentionally toward a clearer job model rather than ship an awkward half-step queue

## Decision Rule For Revisiting This

Re-open FIFO / job implementation only when one of these becomes true:

- `busy_error` shows up frequently enough to interrupt normal development flow
- more than one active writer becomes a normal expected workflow
- long-running write operations need queueing instead of fail-fast behavior
- unattended automation becomes a real requirement
- users need queue visibility, cancellation, or result recovery after disconnects

## Suggested Next Action

Use the current validated package as the development baseline and postpone FIFO / job implementation.

Immediate next step:

- continue real project usage in `neonnew` with the current interactive `codex` workflow
- collect actual `busy_error` frequency and friction points
- only start a new implementation plan if the above revisit conditions are met
