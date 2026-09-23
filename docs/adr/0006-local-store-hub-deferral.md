# ADR 0006: Defer a local-store Hub and LAN sync

- Status: accepted
- Date: 2026-09-19

The modernization keeps Hub as the cloud control plane. A local store Hub,
LAN peer synchronization, offline authority, and conflict resolution protocol
are explicitly deferred from this migration slice.

POS/Kiosk/Queue may still keep a bounded device cache, local drafts, and
idempotent retry queues. Those mechanisms must write through the canonical API
and must not become a second source of truth for memberships, assignments,
entitlements, orders, payments, or inventory.

Revisit this decision only with an explicit ADR covering authority, conflict
resolution, device enrollment, replay protection, and operational recovery.
