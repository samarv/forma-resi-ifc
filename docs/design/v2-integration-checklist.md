# v2 integration checklist (orchestrator)

Items surfaced by the wave-1/2 agent reports that are applied at wave boundaries (not under running agents).

## After wave 2 lands (before wave 3)
- [ ] `src/core/spec.ts resolveFloors`: podium storeys with use retail/amenity default to `groundFloorToFloor`
      (typology ground f2f, 4.0–4.5 m), parking podium storeys to 3.3 m — a 3.0 m retail storey cannot hold the
      0.90 m transfer beam + 2.40 m shop (K: ca-point-tower L03 was raised 3.00 → 3.90 by the profile). Then assert
      `raiseFloorToFloorTo === null` for all 10 presets in presets.test.
- [ ] Re-baseline writer perf budget for ca-point-tower (F: 880 ms with a 47.5k-element tower; not a regression).
- [ ] `arch-elements.ts FURNITURE_IFC` is unreachable (F owns the mapping now) → delete; `cores.ts wallAlongFraction` dead → delete.
- [ ] `storageVolume` in unit-layout runs before counter widths are quantised (≤ 50 mm stale) — recompute after quantisation or accept.
- [ ] `CorridorSpine.centerline` stays the FULL spine (R); update the plan note; `legs` carries the segmentation.
- [ ] S/K: `StoreySizing.transferZoneDepth` is the whole zone; `StackProfileInput.transferZoneDepth` is the part below the
      soffit; registry subtracts slabTAbove — add the field comment.
- [ ] Fixtures patched with `allowStoreyOverride: true` (mock-model, writer.test, MEP test-fixtures) — fine; consider a
      wider-band typology for the 1/2/10/20-storey fixtures.

## Wave 3 (K's step 7 + finish)
- [ ] Remove the ledger mirroring suspension (K): `DesignModel.warnings = ledger.warnings()` for real; drop `mirrorInto`.
- [ ] Delete `src/core/coordination.ts` shim, `SIZES.slabT/coreWallT`, `DEFAULT_LANES`, `plenumBands` and every v1
      consumer; make `GenContext.presize/kernel/rules/issues` required; flip optional v2 fields to required where the
      wave implemented them.
- [ ] Unskip `coordination.test.ts` #14–#29, `presets.test.ts` #30 (zero violation/error on all presets),
      `no-duplicate-constants.test.ts` #33 (deleted identifiers absent).
- [ ] Register K's label-only site issue ids as rules (TYP-01.storeyBand, SIT-07.*, SIT-08.*, SIT-02.*, SIT-01.*, SIT-00.geometry).
- [ ] README + CONTRACT refresh (v2 pipeline, presets table with new numbers, editor + rules tab), `docs/design/v2-plan.md`
      numbers; `node scripts/build.mjs --strict`; browser verification (doors on ±X/±Y walls, editor, issues panel,
      rules form, mapped-item furniture in embed.ifclite.com, storey isolate); `cp dist/forma-resi-ifc.html docs/index.html`; push.
