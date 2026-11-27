# Hidden-parents query guard: resolve paths with Payload's own resolver

Status: built, revision 3 (what the build found is under "What the build found"). Package: `packages/payload`. Written 2026-11-26, revised after the reviewer's note the same day.

## Why

The guard in `packages/payload/src/privacy.ts` (`guardParentQueries`) stops a requester from asking "is this hidden record the parent?" through a filter, sort, distinct field or join. It does this by parsing key strings: `dotted()` replaces `__` with `.`, `classify()` splits on `.`, and `walkPath()` follows relationship paths using `relationMap()`. Eight review rounds have each found another spelling Payload accepts and the parser does not. Round 8 found locale segments (`lherd.en`, `lherd__en`), globals (no guard installed), join names with `__` (looked up through `dotted(name)` while Payload uses the name as given), and docs that claim more than the code does.

The cause is structural. Payload decides what a key means in `getLocalizedPaths`, and our parser is a second, smaller copy of that decision. The change is to stop keeping a copy: ask Payload what each key resolves to, then judge the field it lands on.

## What Payload does today (3.92.1, read from `dist/`)

Installed version in the reference checkout: payload 3.92.1.

- `validateQueryPaths` (`dist/database/queryValidation/validateQueryPaths.js`) walks a where object. A key whose lower-case form is `and` or `or`, with an array value, recurses into each item (so `AND`, `Or` count). Every other key goes to `validateSearchParam` once per operator. A non-array value under `and` or `or` is read as a field named `and` or `or` and fails as an unknown field.
- `validateSearchParam` (`validateSearchParams.js`) turns the key `_id` into `id`, and otherwise applies `incomingPath.replace(/__/g, '.')`. Then it calls `getLocalizedPaths({ collectionSlug, fields, globalSlug, incomingPath, locale, overrideAccess, payload, showHiddenFields })`. The result is an array of `{ collectionSlug, field, path, invalid, complete }` with **one entry per collection the key passes through**. A relationship or join hop completes the current entry and appends the entries of the related collection, so `animal.clutch.mother` gives three entries (host, individuals, cohorts). Inside one entry, groups, tabs, arrays, blocks and locale codes are consumed into `path` (`lgrp.en.herd`) and `field` is the last field matched. An unknown segment, a hidden field (when `overrideAccess` is false), or a polymorphic relationship followed by anything but its own name, `relationTo` or `value` marks the entry `invalid`.
- For `contains` with a plain-object operand on a key that resolves to exactly one entry whose field is a hasMany relationship or upload with a string `relationTo` (`isNestedHasManyQuery`), or a join with a string `collection` (`isJoinContainsQuery`), Payload recurses with `validateQueryPaths` against the related collection's config (its plain `flattenedFields`). With any other relationship, `like`, `not_like` or `contains` and a plain-object operand (or an array holding one), Payload records an error.
- Sorting goes through `validateSortQuery`, which strips one leading `-`, applies the same `__` rule and calls `getLocalizedPaths`. The MongoDB adapter's `buildSortParam` strips one leading `-` and does not apply the `__` rule.
- `getLocalizedPaths`, `validateQueryPaths`, `validateSearchParam`, `getFieldByPath`, `buildVersionCollectionFields` and `buildVersionGlobalFields` are exported from the `payload` package root (`dist/index.d.ts` lines 548, 564, 565, 653, 681 and 682). No deep imports are needed.

### Which operations run which hooks (collections and globals)

Read from `dist/collections/operations/*.js`, `dist/globals/operations/*.js` and `dist/collections/operations/utilities/types.js`:

| Operation | `beforeOperation` runs | Hook `operation` value | Access function that runs when `overrideAccess` is not true |
| --- | --- | --- | --- |
| Collection `find`, `findByID`, `findVersions`, `findVersionByID` | yes | `read` (all four, through `operationToHookOperation`) | `access.read` or `access.readVersions` |
| Collection `count`, `countVersions`, `update`, `delete`, `findDistinct` | yes | `count`, `countVersions`, `update`, `delete`, `readDistinct` | the matching access |
| Global `findOne`, `update`, `restoreVersion`, `countGlobalVersions` | yes (`countGlobalVersions` reports `countVersions`) | | `access.read`, `update`, `readVersions` |
| Global `findVersions`, `findVersionByID` | **no** | none | `executeAccess(globalConfig.access.readVersions)` |

Two consequences. First, `findVersions` on a collection reports `read`, so the hook cannot tell a plain find from a versions find, and the guard has to consider both field sets for `read`. Second, Local `findGlobalVersions`, REST `/globals/<slug>/versions` and GraphQL `versions<Slug>` all go through the global `findVersions` operation, which never calls `beforeOperation`, so a guard installed there leaves them open (cases G1, G3, G4).

## Design

### 1. A resolver-based classifier

New file `packages/payload/src/parentPaths.ts`, used by `guardParentQueries` in place of `dotted`, `classify` and `walkPath`. These three functions and `relationMap` are deleted, not kept as a fallback, so there is only one rule.

```
resolveKey(payload, slug, fieldSets, rawKey, locale) -> Resolution[] | 'unresolved'
classify(resolution, guardedFields) -> 'exact' | 'below' | null
```

`resolveKey`:

1. Refuses a key of more than 100 dot-separated segments before resolving (fail closed, and keeps `getLocalizedPaths`'s own recursion bounded). A key is turned into Payload's form exactly as `validateSearchParam` does: `_id` becomes `id`, then `replace(/__/g, '.')`. This is the one place a line is copied. The differential test pins it to Payload's behavior, and a mutant that skips it must fail.
2. For each field set that applies to the operation (below), calls `getLocalizedPaths` with `collectionSlug`, `fields`, `locale: req.locale`, `overrideAccess: false`, `showHiddenFields: false` and `payload: req.payload`. These are the arguments an untrusted caller gets from Payload.
3. Treats a call that throws, an entry with `invalid: true`, or an entry with no `field` as unresolved in that field set. A key unresolved in every field set is refused with the existing `refused()` error. A key resolved in at least one set is classified from the sets where it resolved. Payload would reject most unresolved keys anyway; refusing first keeps the guard closed if a later release stops rejecting one.
4. Refuses a resolution of more than 9 entries (more than 8 relationship hops), as the current guard does.

`classify` compares by **field identity**, not text. For each entry, `guardedFields(payload, opts, entry.collectionSlug)` lists the parent field objects of that collection (the individuals' role fields or `parentage` fields, the cohorts' birthing parent), found once by walking the collection's `flattenedFields` along the paths from `guardedPaths(opts, slug)` and cached per collection. If `entry.field` is one of them, the answer is `'exact'` when the entry is the last, `'below'` when more entries follow (a filter on the parent's own fields, such as `dam.name`, or `dam.id`). Locale codes, `__`, group names, tabs, arrays and blocks stop mattering because `getLocalizedPaths` has consumed them and `field` is the object itself. The cohort path `clutch.mother` on individuals is no longer a special case: the hop into the cohorts collection yields an entry on `clutches` whose field is the birthing parent.

A shape test (`test/resolver-shape.test.ts`) fixes what the guard relies on: for a fixture config it asserts the entry count, `collectionSlug`, `invalid`, `complete` and `path` for a plain key, a hop, a localized key with and without a locale segment, a group-and-array key, a polymorphic key and a join key, and that `entry.field` is the same object as the one in the collection's `flattenedFields`. An upgrade that changes any of these fails there first.

### 2. Field sets, versions, recursion

Field sets per hook `operation`:

- `countVersions` (collections): the version fields only.
- `read`: the plain `flattenedFields`, plus the version fields when the collection has `versions` configured (`Boolean(config.versions)`, what Payload's `hasVersionsEnabled` does).
- Everything else (`count`, `update`, `delete`, `readDistinct`): the plain `flattenedFields`.

The version fields are built **as Payload's `findVersions` builds them**: `buildVersionCollectionFields(payload.config, collectionConfig, true)`, cached per collection config, and passed to `getLocalizedPaths` as `fields`. There is no `version.` prefix stripping and no fallback. If the builder throws, the guard refuses. The global equivalent, `buildVersionGlobalFields(payload.config, globalConfig, true)`, is not needed because no global version query is resolved by the guard (section 3). The rule from the earlier draft that stripped a `version.` prefix is gone; the old fallback is how the version-prefix mutant (R2) drifted back before.

A `read` that is a plain find with the key `version.dam` resolves only in the version set and is refused as a parent path. Payload would reject that key on a plain find anyway, so nothing legitimate is lost. A collection with its own field named `version` is classified by whichever set matches, which can refuse a harmless key. That is the safe direction.

Recursion where Payload recurses, and one place where we are stricter:

- A plain-object operand under `contains` on a key that resolves to a single entry whose field is a hasMany relationship or upload with a string `relationTo`, or a join with a string `collection`: the operand is a where object for that collection. The guard recurses with that collection's slug and its plain `flattenedFields`, with the same unresolved-key refusal, a depth counter and the same shared id list. A nested `and` or `or` (any case) recurses as in Payload.
- Any other plain-object operand, or an array holding one, on a relationship, upload or join field is refused, with two exceptions that Payload accepts for ordinary use: `{ relationTo, value }` and `{ id }` with primitive values, under `equals`, `not_equals`, `in`, `not_in` and `all`. This is stricter than Payload and is fail-closed. Operands on other field types (such as a geo `within` object) are untouched.
- Operand rules for an `exact` hit are unchanged: `equals`, `in`, `not_equals`, `not_in` only with readable ids (`readableIds()`), `exists` and empty only in placeholder mode, other operators refused, object operands without an id refused.
- Nesting depth is capped at 32 (and, or, contains) and refuses beyond that, so deep and cyclic where objects fail closed instead of overflowing the stack.

Joins: Payload keys `joins` by the name as the caller wrote it. The guard finds the join field by walking `flattenedFields` along the dot-separated name, with no `__` rewrite. A name that does not resolve to a `join` field on this collection is refused. The join's `where` and `sort` are run through the same `check()` against each target collection in the join field's `collection` (a polymorphic join tolerates a key that is unknown on one target and resolves on another, as Payload does; a key unresolved on all targets is refused).

Sort and distinct: `sort` keys (string, comma list, array) lose leading `-`, `+` and spaces and then go through `resolveKey` and `classify`; `exact` or `below` is refused, and so is an unresolved key. `findDistinct`'s `field` takes the same path.

### 3. Installing the guard, and globals

`plugin.ts` currently adds `guard` to `collections` at config time and again for late collections in `onInit`, and never touches globals.

Collections: a single function `installGuard(collection)` pushes `guard` onto `hooks.beforeOperation` once. The config-time pass runs it over `config.collections`; the `onInit` pass runs it over `payload.config.collections` and the `payload.collections` configs for entities added by later plugins and by Payload itself (`payload-locked-documents`, `payload-preferences`). Version reads on a collection run through the parent's `findVersions`, `countVersions` and `findVersionByID`, which all call `beforeOperation` (table above), so installing on the parent covers them.

Globals: `beforeOperation` is **not** a sufficient host. In `dist/globals/operations`, `findVersions.js` and `findVersionByID.js` never call it. Only `countGlobalVersions` (as `countVersions`), `findOne` (`read`), `restoreVersion` and `update` do, and none of those take a where. So the guard for globals sits where every global version read does pass, for every caller who is not trusted: `executeAccess(globalConfig.access.readVersions)`. `findVersions`, `findVersionByID` and `countGlobalVersions` all call it when `overrideAccess` is not true, whether from REST, GraphQL or Local.

`installGuard(global)` wraps `access.readVersions` on every global that has `versions`:

```
readVersions' = (args) =>
  exposed(global) && !(await canReadEveryIndividual(args.req, opts))
    ? false
    : (global.access.readVersions ?? defaultAccess)(args)
```

- `canReadEveryIndividual` is what `readableIds` already computes as `all`: the individuals collection's `access.read` returns exactly `true` for this request. A caller who can read every individual has nothing hidden to probe, so the host's own `readVersions` answers as before, including a where-returning result.
- `exposed(global)` is true when the global's fields (any depth: groups, arrays, blocks, tabs) hold a relationship, upload or join whose target can reach the individuals or cohorts collection through relationship fields, computed lazily on first use from `payload.collections` and cached per config. A footer global with links to pages, and the plugin's own graph and settings globals, stay as the host wrote them.
- A refused caller gets what the host's own `false` gives: `403` over REST, a thrown error over Local, an error over GraphQL, and `totalDocs: 0` for `countGlobalVersions`. A hidden id and a made-up id are answered the same way because the where is never read.
- This is deliberately coarse. It cannot see a Local or GraphQL where from inside an access function, so the guard does not try to: it fails closed for callers who cannot read every individual. The cost is that such callers lose version history of globals that reference individuals. The Admin UI follows the same access, so the version view of such a global is hidden for them. This is written in the README. A host that needs partial readers to see those versions can read them with its own server code (`overrideAccess`) and shape the answer itself.
- The rejected options: replacing the REST endpoints and patching `payload.findGlobalVersions` leaves GraphQL, which calls the operation directly; wrapping `payload.db.findGlobalVersions` cannot tell a trusted call from an untrusted one and sees the access constraints Payload merged into the where.
- `onInit` applies the same wrap to globals added later, and the wrap is marked so it is applied once.

**Meta-test, by behavior** (`test/guard-installed.test.ts`): the fixture has a collection, a versioned collection, a global with a relationship to individuals and versions, a global with no such reference, a collection added by a later plugin and the internal collections. The test does not stop at "the hook is in the list". For every entity it runs the same hidden-versus-made-up probes the review used and asserts they answer alike over REST, Local with `overrideAccess: false` and GraphQL:

- collections: `where` on `animal.dam`, `version.animal.dam`, `lherd.en`, `version__animal__dam` and a join name with `__`, on find, count, versions and bulk update;
- globals: G1 (`version.herd contains {dam}`), G3 (Local `findGlobalVersions`), G4 (`version.herd.dam`, `version__animal__dam`, the `in` form), `countGlobalVersions`, `findVersionByID` and GraphQL `versions<Slug>`;
- sanity: a caller who can read every individual still gets a real answer, a caller with partial read gets the same refusal for a hidden and a made-up id, a trusted Local call still filters by a hidden id, and the unexposed global's versions are served as the host wrote them.

A second assertion lists the entity-holding keys of `payload.config` (an array whose items have `slug` and `fields`) and requires exactly `collections` and `globals`, so a future entity kind shows up in review. The mutants "install on beforeOperation only" and "skip the readVersions wrap" must fail this file.

### 4. Differential test

New `test/hidden-parent-differential.test.ts` (shared body, one file per `hiddenRecords` mode, because Payload keeps one instance per process), seeded from the reviewer's probes r3 to r7 and their fixture (herd, animals, clutches, weighings, notes, photos, pens, the `featured` global, localization `en` and `fr`, the plugin that adds `notes` after OnePedigree). Every seed case becomes a row: its id, its transport (REST, Local with `overrideAccess: false`, GraphQL), its where, and its expected kind.

- **Equality rows:** for a caller who cannot read the hidden individual `H`, the answer with `H` equals the answer with a made-up id `N`, after replacing ids with placeholders. Rows carry both the answers and a flag for the refusal rows (sorts, `exists` in omit mode), which are compared by their whole output.
- **Difference rows:** where the case says a readable-parent caller must differ (the readable id answers differently from `N`), the test asserts it, so a guard that refuses everything cannot pass. For exposed globals the difference row uses a caller who can read every individual (partial readers are refused by design, section 3).
- **Fixed expectations from the confirmed leaks.** L1, L2, L4 to L7, K3, L9, G1, G3, G4, J9 and J11 are named rows that fail on 88ff1c1 and 2816d47. K8 (`exists` on `lherd.en.dam`) is run, its output recorded, and the test asserts what the investigation finds.
- **Generated rows** from the sanitized config: for every path that reaches a parent field (found by walking `flattenedFields`, not hand-listed), the dot, `__` and mixed spellings, every locale code as trailing and middle segment, the `version.` and `version__` prefixes, the operator forms `equals`, `in` (array and comma string), `not_equals`, `not_in`, `exists` and `contains` with nested `and`, `or` (any case), `in` and a second hop, sort and distinct forms, and join names as given. They run through REST (list, count, versions, bulk PATCH, `/globals/.../versions`), Local and GraphQL.
- **Mutants:** a script (`scripts/mutants.mjs` inside the package, not shipped) applies each mutant to `src` in a temporary copy, runs the suite and requires failures, then restores. The mutants are the reviewer's lists (r4 G1 to G15, r5 R1 to R4, r6 N1 to N6, r7 R1 to R7) rewritten for the new functions, plus the three from this note: raw key lookup without the `_id` and `__` normalizing, no locale clean-up (compare by text instead of field), and a dotted join name. Mutants that have no equivalent in the new design (for example "no version strip") are mapped to their replacement ("version fields omitted from the sets") and the mapping is listed in the CHANGELOG entry. Every mutant must fail at least one named test, and a mutant that passes the whole suite is a gap to close before the work is done.

### 5. How each round 8 finding is closed

- Locale segments in `where`, `version.` forms, bulk PATCH, Local, `lgrp.en.herd contains` and `lgrp.en.herd.dam equals`: `getLocalizedPaths` consumes locale codes, and the classifier compares field objects, so `lherd.en` and `lherd` are the same field.
- Globals: version reads are guarded through `readVersions` (section 3). Covered by the G rows and the behavioral meta-test.
- Raw join names such as `my__mates`: the join lookup uses the name as given and refuses an unknown name. Covered by a join-name row (J9, J11) and the dotted-join-name mutant.
- README (lines 76 to 79 of `packages/payload/README.md`), the CHANGELOG entries and the Design notes are rewritten after the code works, to say only what the tests cover: which entity kinds, which spellings, which operations. The "Not tested" lines list what the generator does not reach. The round 7 CHANGELOG text that says join names are not rewritten stays true and is folded into the new entry.
- No test used a `__` key with a nested operand and the raw-key mutant survived: the generator crosses `__` and locale spellings with nested `contains`, `in`, `and` and `or`, and the raw-key lookup is a named mutant.

## Risks

- **Payload internals.** `getLocalizedPaths`, `validateQueryPaths`, `validateSearchParam` and the version builders are exported from the package root but are not documented API, and `PathToQuery` can change in a minor release. The peer range for `payload` becomes `~3.92.1` (`>=3.92.1 <3.93.0`). It is widened one minor at a time, and only after the full suite, the differential test and the mutant script pass on that minor. The shape test (section 1) fails first on a changed return shape. If a function throws or returns a shape the guard does not recognize, the key is refused. The optional `@payloadcms/ui` peer moves to the same range so the two stay on one line.
- **Copied lines.** The `__` replacement and the `_id` rule are copied from `validateSearchParam`. The differential test keeps them honest, and a Payload release that changes the replacement shows up as a failing spelling.
- **Field identity.** Classification compares the field object `getLocalizedPaths` returns with the object in the collection's `flattenedFields`. If a Payload release clones the arrays per call, every leak row fails at once, which the shape test also catches.
- **Performance.** One `getLocalizedPaths` call per key per field set, which is linear in the key length. `guardedFields` is cached per collection. The readable-id lookup is unchanged. A test resolves a where tree of about 10,000 characters and asserts it finishes within a generous bound (recorded in the PR with the measured time).
- **Global versions.** The coarse readVersions rule loses version history for partial readers on globals that reference individuals. It is the choice that covers all three global version operations without depending on a hook Payload does not call. A finer rule needs a hook Payload does not provide.
- **Still not covered.** A parent id kept in a non-relationship field (a text field holding an id); the plain-text `relationTo` form of a polymorphic relationship beyond `.value`; a real Next.js route handler; a database other than MongoDB; custom endpoints in a host that build their own queries without going through Payload's operations; any host access function that reveals the hidden record by other means; collections added to `payload.config` after `onInit`; a late global's versions or a join from a late collection as the first operation of a process whose adapter was replaced with `onInit` off (the same trip point covers them in principle, but only find, count, sort and distinct are tested).
- **Parked.** The separate field with field-level read access (point 4 of the reviewer's plan) is not part of this work; it is an owner decision, only if sections 1 to 4 do not converge.

## Base-probe cases B, C, E, G, A.validate and R3.cycle (answered)

The base probe (cases A to R6) was rerun at 9a72b5e in both modes. The same six cases show `equal: false` as at 2816d47. Each was compared after relabeling the ids and names the caller supplied.

| Case | Verdict | Reason |
| --- | --- | --- |
| B (readable mother, cohort with a hidden mother vs none) | intended | The outputs match once the clutch id the caller sent is relabeled; same status and shape, no hidden parent shown. |
| C (hidden cohort vs made-up cohort) | intended | Only the caller's own clutch id differs. A hidden cohort is accepted like a made-up one. |
| E (cohort write, hidden conflicting member vs none) | intended | Only the probe's own record names differ; both answer 200 with the same body. |
| G (visible member with a hidden dam vs no dam) | intended | Same: only the probe's record names differ. |
| A.validate (guessing a hidden parent on the validate endpoint) | intended | All three answers are `UNRESOLVED_PARENT`; `relatedIds` only echoes the id the caller sent. |
| R3.cycle (parent whose line runs through a hidden record) | deliberate trade-off | The refusal stays. See below. |

**R3.cycle.** Proposing a readable animal as a parent is refused with `PARENT_IS_DESCENDANT` when it already descends from the child, even when the line runs through a record the editor can't read. The caller learns that a hidden record links two records they can read. No hidden id, name or count is shown. Ignoring hidden links would let a real loop be saved, so the refusal stays. The message is the same whether or not the line runs through a hidden record, and says so gently: "This animal can't be a parent here, because it already descends from this animal in the family line. Some of that line may belong to records you can't see." The error code is unchanged. This differs from the birthing-parent checks, where the answer was made independent of hidden records and the cost is documented: there, ignoring a hidden record cannot corrupt the pedigree.

## What the build found

- **Locale segments are dropped by Payload.** `getLocalizedPaths` skips one segment too many after a locale code on a relationship (`nextSegmentIsLocale ? i + 2 : i + 1` after `i` was already advanced), so `lherd.en.dam` resolves to the `lherd` field alone. K8 (`where[lherd.en.dam][exists]=true` on weighings) therefore filters on `lherd` and names no parent: it answers 200 in both modes, and exactly like `where[lherd.en][exists]=true`. On 88ff1c1 it also answered 200. It is not a leak, and the differential test pins it (`K8`), as the shape test pins the resolver behavior. K3 (`lgrp.en.herd.dam`) is different: the locale sits after the group, the segment after `herd` is kept, and the key resolves to the parent field. L9 (`exists` under a nested `contains`) is refused in omit mode now.
- **`disableOnInit`.** Payload's own CLI scripts start without `onInit`, and the old and the first new install both relied on it for collections and globals that a later plugin adds. The plugin now also wraps the database adapter's `init`, which runs in every start before `onInit`, and installs the guard there. `onInit` still runs the same pass for anything added after that. Covered by `test/guard-noinit.test.ts` (a plugin-added collection and global version reads), which failed on the old code.
- **Replaced adapter, `onInit` off, first query on a late collection.** Then no code of the plugin has run, and a late collection has no hook of ours, so an operation on it passes through nothing. Every filter, sort or distinct on it that reaches a parent field first makes Payload evaluate `access.read` of the collection that holds the field (individuals, cohorts). That function is wrapped: if the guard isn't confirmed installed for the running config it installs it, then refuses that one operation with the guard's own message, so the hidden id and a made-up one get the same answer. Once installed it passes the host's answer through unchanged. If installing fails, the error is thrown instead. Covered by `test/guard-late-install-first-query-{find,count,sort,distinct}.test.ts`, which seed through the adapter so no guard has run, and failed on a9b7b69. Cost: in that start mode only, the first operation that reaches those two collections from outside (an admin permissions request, for example) is refused once.
- **Globals added by a later plugin and globals reached through other collections** are covered by the `lateGlobal` and `chain` globals in the fixture.
- **Hidden fields.** `getLocalizedPaths` marks a `hidden: true` field invalid for an untrusted caller. The guard treats that as unresolved and refuses with its own message instead of leaving the refusal to Payload.
- **Segment limit.** A key of more than 100 segments is refused before resolving. The hop limit (more than 8 hops) refuses the same keys earlier in practice, so no test separates the two and this mutant is listed as redundant.

## Peer, version and other review points, in one place

| Review point | What the note now says |
| --- | --- |
| 1. Peer pin | `~3.92.1`, a shape test on `getLocalizedPaths`, widen one minor at a time after suite, differential test and mutants pass |
| 2. Version fields | `buildVersionCollectionFields(payload.config, collectionConfig, true)` passed to `getLocalizedPaths`, no prefix stripping, refuse if the builder throws; no global builder needed because no global version query is resolved |
| 3. Global version reads | `beforeOperation` is not called by global `findVersions` and `findVersionByID`; the guard wraps `access.readVersions`, which every global version read runs for untrusted callers; fails closed for callers who cannot read every individual |
| 4. Meta-test | Checks behavior (G1, G3, G4, L and J probes over REST, Local and GraphQL), not that a hook is present |
| 5. Seed | Every case becomes a row in both modes; confirmed leaks are named rows that fail on 88ff1c1 and 2816d47; the mutant lists are rerun |
| 6. Open item | Base-probe cases: answered after the probe source arrived (five intended, R3.cycle a deliberate trade-off) |

## Plan

1. Add the shape test, the behavioral meta-test and the differential test with the seed first, and watch the confirmed leaks fail on 2816d47.
2. Add `parentPaths.ts`, `installGuard` and the readVersions wrap; delete `dotted`, `classify`, `walkPath` and `relationMap`.
3. Rerun the mutants and the full suite twice, typecheck, build and the leak check.
4. Rewrite the README, CHANGELOG and Design notes lines to match what is tested. Done, including the base-probe answer.
