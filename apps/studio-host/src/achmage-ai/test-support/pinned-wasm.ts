/// <reference types="node" />
// Tests run the vendored rhwp engine, byte for byte the one PROVENANCE.json names. Replacing the WASM
// (a new upstream pin or a HOP patch build) therefore means updating its provenance record first.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { initSync } from '../../../vendor/rhwp-core/rhwp.js';

const vendor = new URL('../../../vendor/rhwp-core/', import.meta.url);
let initialized = false;

/** Initializes the engine once per test module; throws if the WASM is not the one in PROVENANCE.json. */
export function initPinnedEngine(): void {
  if (initialized) return;
  const provenance = JSON.parse(readFileSync(new URL('PROVENANCE.json', vendor), 'utf8')) as { artifacts: Record<string, { sha256: string }> };
  const bytes = readFileSync(new URL('rhwp_bg.wasm', vendor));
  if (createHash('sha256').update(bytes).digest('hex') !== provenance.artifacts['rhwp_bg.wasm'].sha256) throw new Error('Pinned WASM changed; audit it and update PROVENANCE.json');
  initSync({ module: bytes });
  initialized = true;
}
