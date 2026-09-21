/**
 * SEAM — ceiling profiles for the structural pre-sizing. **Swapped in**: the kernel agent's real tables have
 * landed in `src/core/kernel/profiles.ts` (the nine `CeilingProfile`s with their band stacks, clear heights,
 * lanes and code sources), so this file is now just the one-line indirection that made the swap possible.
 *
 * `presizeStructure` needs exactly two things from the kernel: the profile id for a storey (through the
 * `ProfileBook` it is handed) and the resolved ceiling / clear height for a concrete floor-to-floor, slab and
 * structural depth — plus the "this storey has to get taller" answer, which only the pre-sizing can act on.
 *
 * NOTE on `StackProfileInput.transferZoneDepth`: the pre-sizing passes the part of the transfer zone that hangs
 * BELOW the slab soffit (the transfer beam), because `soffitZ = floorToFloor - slabTAbove` has already taken the
 * 0.30 m transfer slab off. `StructuralPresize.transferZoneDepth` stays the whole 1.20 m zone, as the contract
 * documents it.
 */
export { createProfileBook, stackProfile } from '../../core/kernel/profiles.ts';
