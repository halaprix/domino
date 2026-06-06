/**
 * Post-build: no longer needed in v2.
 *
 * v1 rewrote ethers-v5 imports. v2 has a single EIP-1193 engine — no
 * import rewriting required. This script exists only to preserve the
 * build pipeline; it always exits cleanly.
 */
console.log('postbuild: v2 — nothing to rewrite (EIP-1193 engine only)')
