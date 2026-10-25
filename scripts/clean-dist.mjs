import { rm } from 'node:fs/promises';

// TypeScript does not remove outputs for renamed/deleted source modules.
// Only discard this checkout's generated output, never source or dependencies.
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
