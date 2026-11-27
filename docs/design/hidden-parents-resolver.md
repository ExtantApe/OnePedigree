# Hidden-parents query guard: resolve paths with Payload's own resolver

Status: proposal, for review before any code. Package: `packages/payload`. Written 2026-11-26.

## Why

The guard in `packages/payload/src/privacy.ts` (`guardParentQueries`) stops a requester from asking "is this hidden record the parent?" through a filter, sort, distinct field or join. It does this by parsing key strings: `dotted()` replaces `__` with `.`, `classify()` splits on `.`, and `walkPath()` follows relationship paths using `relationMap()`. Eight review rounds have each found another spelling Payload accepts and the parser does not. Round 8 found locale segments (`lherd.en`, `lherd__en`), globals (no guard installed), join names with `__` (looked up through `dotted(name)` while Payload uses the name as given), and docs that claim more than the code does.

The cause is structural. Payload decides what a key means in `getLocalizedPaths`, and our parser is a second, smaller copy of that decision. The proposal is to stop keeping a copy: ask Payload what each key resolves to, then judge the field it lands on.

## What Payload does today (3.92.1, read from `dist/`)

Installed version in the reference checkout: payload 3.92.1. This package declares the peer range `^3.80.0` and the dev dependency `^3.92.1`.

- `validateQueryPaths` (`dist/database/queryValidation/validateQueryPaths.js`) walks a where object. `and` and `or` recurse. Every other key goes to `validateSearchParam` once per operator.
- `validateSearchParam` (`validateSearchParams.js`) does the following with each key: `incomingPath.replace(/__/g, '.')`, then `getLocalizedPaths({ collectionSlug, fields, globalSlug, incomingPath, locale, payload, ... })`. The result is an array of `{ collectionSlug, field, path, invalid }`, one entry per resolved segment. It handles `__`, locale segments, blocks, tabs, arrays, polymorphic `.value`, relationship hops into the related collection, and marks unknown segments `invalid`.
- For a `contains` operator on a hasMany relationship whose operand is a plain object, Payload recurses with `validateQueryPaths` against `req.payload.collections[relationTo].config` (the code names this `isNestedHasManyQuery`). Join fields take a similar path (`isJoinContainsQuery`), and a nested `and` is merged for access constraints.
- When the resolved path has more than one segment past the first, it validates the tail against the deepest related collection.
- Sorting goes through `validateSortQuery` and the same resolver. Joins are validated per join, keyed by the join name as the caller wrote it.
- `getLocalizedPaths`, `validateQueryPaths` and `validateSearchParam` are exported from the `payload` package root (`dist/index.d.ts` lines 548, 564 and 565). We do not need deep imports.

## Design

### 1. A resolver-based classifier

New file `packages/payload/src/parentPaths.ts`, used by `guardParentQueries` in place of `dotted`, `classify` and `walkPath`. These three functions are deleted, not kept as a fallback, so there is only one rule.

```
resolveKey(req, entity, rawKey, { versions }) -> Resolved | 'unresolved'
classifySegments(resolved) -> 'exact' | 'below' | null
```

`resolveKey`:

1. Normalizes `_id` to `id` and applies `replace(/__/g, '.')`, exactly as `validateSearchParam` does (this is the one place we copy a line, and the differential test below pins it to Payload's behavior).
2. Calls `getLocalizedPaths` with `fields` set to the entity's `flattenedFields` (for a version query, the version fields, see section 2), `locale: req.locale`, `overrideAccess: false`, `showHiddenFields: false`, `payload: req.payload`.
3. Returns `'unresolved'` if the call throws or any segment has `invalid: true` or no `field`. The guard refuses an unresolved key with the same `refused()` error used today. Payload would reject most of these anyway; refusing first makes the guard fail closed even if a later Payload release stops rejecting one.

`classifySegments` walks the returned array. For each `{ collectionSlug, field, path }`:

- The segment is guarded when `collectionSlug` is the individuals or cohorts collection and the field's path (after the locale and `.value` clean-up Payload does) is one of `guardedPaths(opts, slug)`, the same list used now. If it is the last segment the answer is `'exact'`. If more segments follow it the answer is `'below'`.
- The answer is decided by the field and the collection slug Payload resolved, not by the text of the key. Locale codes, `__`, group names, tabs, arrays and blocks stop mattering, because `getLocalizedPaths` has already consumed them.

### 2. Recursion where Payload recurses

`getLocalizedPaths` follows ordinary relationship hops itself and reports the related collection's slug on later segments, so `animal.clutch.mother` yields segments on `weighings`, `animals` and `clutches` with no extra work. Two places need our own recursion, both mirroring Payload:

- Nested operands on a hasMany relationship or a join under `contains` (`isNestedHasManyQuery`, `isJoinContainsQuery`): the operand is a where object for the related collection. `check()` recurses with that collection's slug, looked up as `req.payload.collections[relationTo].config`. The condition for recursing is Payload's own: operator `contains` and `isNestedRelationshipQuery(val)` (plain object). We go further than Payload in one way: for any other operator carrying a plain-object operand on a relationship or join field, we refuse. Today the guard walks every operator's object operand; refusing is simpler and fails closed.
- Polymorphic relationships (`relationTo` is an array): Payload's resolver handles `.value`. For the nested operand case we recurse into every target, as now.

Versions: Payload validates `findVersions` and `countVersions` with `versionFields` (the `version.*`, `parent`, `snapshot`, `latest` wrapper). The resolver call for a versions operation uses the version fields of the entity. Where the plugin cannot get them from the sanitized config (collections expose `config.flattenedFields` only), the plan is to try `payload.collections[slug].config.versions` with `buildVersionCollectionFields` / `buildVersionGlobalFields` if exported, and otherwise to strip a leading `version.` segment and resolve the rest against the entity, as `walkPath` does today. To be settled while building; the differential test (section 4) decides which works.

Joins: Payload keys `joins` by the name as given and runs each join's `where` and `sort` against the join field's target collection. The guard looks the name up as given: `fieldByName(slug, name)` over the entity's flattened fields, with no `__` rewrite and no `dotted()`. A name that is not a join field on this collection is refused. The join's `where` and `sort` are then run through the same `check()` with the join's target slug.

Sort and distinct: `sort` keys (strings, comma lists, leading `-`) and `findDistinct`'s `field` go through `resolveKey` and `classifySegments`; `exact` or `below` is refused, as now.

Operand rules for an `exact` hit do not change: `equals`, `in`, `not_equals`, `not_in` only with readable ids (`readableIds()`), `exists` and empty only in placeholder mode, other operators refused, object operands without an id refused.

Depth: the existing 8-hop refusal moves into `resolveKey` (more than 8 resolved relationship segments is refused). `getLocalizedPaths` is linear in the key length, so there is no recursion to bound for plain paths. Nested operand recursion keeps the depth counter.

### 3. One install loop, with a meta-test

`plugin.ts` currently adds `guard` to `collections` at config time and again for late collections in `onInit`, and never touches globals. The change:

- A single function `installGuard(entity)` pushes `guard` onto `hooks.beforeOperation` if it is not there, for a collection or a global. Collections and globals both support `hooks.beforeOperation` (`globals/config/types.d.ts` line 237).
- The config-time pass runs it over `config.collections` and `config.globals`, including the plugin's own graph and settings globals.
- The `onInit` pass runs it over `payload.config.collections`, `payload.config.globals` and the `payload.collections` configs, for entities added by later plugins. Version collections are not separate hook hosts in Payload: version reads run through the parent entity's `findVersions` operation, so installing on the parent covers `/versions` and `countVersions`. The meta-test checks this rather than assuming it.
- `guardParentQueries` accepts both hook shapes. For a global it resolves with `globalSlug` and `config.globals`. The operations it guards for globals are `read` (which includes `findGlobalVersions`, reported as a read) and `update`.

Meta-test (`test/guard-installed.test.ts`): start Payload with a collection, a global, a versioned collection, a versioned global, an upload collection, an auth collection and a collection added by a later plugin. Enumerate `payload.config.collections` and `payload.config.globals` from the sanitized config and assert that each has the guard in `hooks.beforeOperation`. A new entity kind that is not in either list will fail the test only if it appears in the config; the second half of the test therefore also asserts the key sets of `payload.config` that hold entities (`collections`, `globals`) are the only two, so a future `payload.config.<new kind>` shows up in review.

### 4. Differential test

New `test/hidden-parent-differential.test.ts`, both `hiddenRecords` modes. Fixture: made-up data with a hidden individual `H` and a made-up id `N`, individuals with parent fields (role fields, standard `parentage` group, localized variants of both), a host collection with a localized relationship, a hasMany relationship and a join to individuals, a versioned collection, a global with a parent reference and versions, and a collection added by a later plugin.

A generator builds, for every path that reaches a parent field (found by walking the sanitized config, not hand-listed), these spellings:

- dot form, `__` form, mixed (`animal.clutch__mother`);
- every locale code on the localized field, both as a trailing segment and in the middle (`lgrp.en.herd`), dot and `__`;
- `version.` and `version__` prefixes on versions endpoints, collections and globals;
- operator forms `equals`, `in` (array and comma string), `not_equals`, `not_in`, `exists`, `contains` with nested operands that themselves use `and`, `or`, `in`, and a second hop;
- sort and distinct forms of each path;
- join names as given, including a join whose name contains `__`.

Each spelling runs through REST (list, count, versions, bulk PATCH and DELETE, `/globals/.../versions`), Local with `overrideAccess: false`, and GraphQL. For each, the assertion is the one from the earlier rounds: the answer for `H` equals the answer for `N`, after replacing ids with placeholders. A second assertion states the oracle's own sanity: a readable id gives a different answer from `N`, so a guard that refuses everything cannot pass. The simplest unguarded query fails on the old code and passes on the new.

The reviewer offered a probe seed from rounds 3 to 7 (the `r5-oracles` and `r5-noinit` probes, with the mutant list). Yes, we want it. It becomes the starting corpus for the generator, and the mutant script is rerun against the new code (mutants 'noVersionStrip', 'noJoinFieldMap', 'noLateGuard' and so on, rewritten for the new function names). We add three mutants for this round: look up the raw key without the resolver, skip the locale clean-up, and look up joins through `dotted(name)`.

### 5. How each round 8 finding is closed

- Locale segments in `where`, `version.` forms, bulk PATCH, Local, `lgrp.en.herd contains` and `lgrp.en.herd.dam equals`: `getLocalizedPaths` consumes locale codes (it knows which fields are localized and which codes exist), so `resolveKey` returns the same field as for the plain key. Covered by the locale rows of the differential generator.
- Globals: `installGuard` runs over `config.globals`; the resolver takes `globalSlug`. The meta-test and the global versions rows in the generator cover `/globals/<slug>/versions`, Local `findGlobalVersions` and the `in` form.
- Raw join names such as `my__mates`: the join lookup uses the name as given and refuses an unknown name. Covered by a join-name row and the new raw-lookup mutant.
- README (lines 76 to 79 of `packages/payload/README.md`), the CHANGELOG entries and Design notes: rewritten after the code works, to say only what the differential test covers: which entity kinds, which spellings, which operations. The "Not tested" lines list what the generator does not reach (below). The round 7 CHANGELOG text that says join names are not rewritten stays true and is folded into the new entry.
- No test used a `__` key with a nested operand, and the raw-key mutant survived: the generator crosses `__` and locale spellings with nested `contains`, `in`, `and` and `or`. The raw-key lookup becomes a named mutant that must fail.

## Risks

- **Payload internals.** `getLocalizedPaths`, `validateQueryPaths` and `validateSearchParam` are exported from the package root, but they are not documented API and their return shape (`PathToQuery`) can change in a minor release. The plan pins the peer range to the minor lines the differential suite has run on (start with `~3.92`, widen only after running the suite on each newer minor) and adds a unit test on `getLocalizedPaths`'s output shape for a fixture config, so an upgrade that changes it fails loudly in CI instead of in production. If the function ever throws or returns a shape we do not recognize, the key is refused.
- **Copied lines.** The `__` replacement and the `_id` rule are copied from `validateSearchParam`. The differential test is what keeps them honest. A Payload release that changes the replacement would show up as a failing spelling, not silently.
- **Performance.** One `getLocalizedPaths` call per key, which is a walk of the field tree along the key's segments. The relation map cache (`relationMap()`) is no longer needed for walking and is removed except for join and nested-operand targets. `guardedPaths` stays cached. Filters with many keys cost more than today but stay linear in total key length. The readable-id lookup is unchanged. Not benchmarked yet; a small benchmark on a 10,000 character where tree will be added to the PR.
- **Version fields.** Resolving `version.*` keys depends on how we obtain the version field list (section 2). If that proves fragile, the fallback is the strip-and-resolve approach, which keeps the old coverage and adds the locale handling.
- **Still not covered.** A parent id kept in a non-relationship field (a text field holding an id); the plain-text `relationTo` form of a polymorphic relationship beyond `.value`; a real Next.js route handler; a database other than MongoDB; custom endpoints in a host that build their own queries without going through Payload's operations; any host access function that reveals the hidden record by other means.
- **Parked.** The separate field with field-level read access (point 4 of the reviewer's plan) is not part of this work; it is an owner decision, only if sections 1 to 4 do not converge.

## Plan after review

1. Add the meta-test and the differential test first, with the reviewer's seed, and watch them fail on 2816d47.
2. Add `parentPaths.ts` and `installGuard`; delete `dotted`, `classify` and `walkPath`.
3. Rerun the mutants and the full suite twice, typecheck, build and the leak check.
4. Rewrite the README, CHANGELOG and Design notes lines to match what is tested.
