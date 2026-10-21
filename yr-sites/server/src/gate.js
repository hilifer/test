// Checkpoints before sensitive operations (a quote with a big discount is sent, money is refunded, a product is deleted).
// Modules register checks here; a check throws to stop the operation. Kept free of imports so any module can call it.
const checks = new Map();
export function onGate(kind, fn) { if (!checks.has(kind)) checks.set(kind, []); checks.get(kind).push(fn); }
export function gate(kind, info) { for (const fn of checks.get(kind) || []) fn(info); }
