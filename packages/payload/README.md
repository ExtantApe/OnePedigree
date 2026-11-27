# @extantape/payload-plugin-onepedigree

[OnePedigree](../../README.md) for Payload CMS 3: parentage on your own collection, cycle-safe
writes, deletion policies, permission-aware pedigree endpoints for all 13 views, and Admin
components (pedigree preview, relatives, color theme settings).

```ts
import { onePedigree } from '@extantape/payload-plugin-onepedigree'

export default buildConfig({
  collections: [Animals, Clutches],
  plugins: [
    onePedigree({
      collection: 'animals',
      mode: 'standard-fields', // or 'managed' (creates the collections) or 'mapped' (your fields)
      cohorts: { collection: 'clutches' },
      hiddenRecords: 'placeholder', // a private relative shows as an anonymous "private record"
      navigation: { individualUrl: '/animals/{id}' },
    }),
  ],
})
```

## Identifiers beside names

`fields.identifier` shows a host identifier after each name in every view, relatives list and
spoken name, e.g. "Mead (REG-AQCR6T)". Give a field path, or a function of the requester so each
person can choose, for example a registry ID or their own studbook number:

```ts
fields: { identifier: ({ user }) => (user?.showStudbook ? 'studbookNo' : 'coId') }
```

A record the requester can't read never shows its identifier: its placeholder carries none.
React's `Terminology.identifierFormat` (default `{label} ({id})`) changes how the two are joined.

## Modes

- **`managed`**: creates `individuals`-style and cohort collections from the factories
  (`createIndividualsCollection`, `createCohortsCollection`).
- **`standard-fields`** (default): adds the `parentage` group (`parents[{ individual, role, kind }]`,
  `reproductiveMode`, `cohort`) to your existing collection.
- **`mapped`**: uses your fields, e.g. `{ kind: 'role-fields', roles: { mother: 'dam', father: 'sire' }, cohort: 'clutch' }`
  or `{ kind: 'parent-array', path: 'lineage', individualField: 'animal', roleField: 'role' }`.
  A row's kind is read from `kindField` (default `kind`); without one, every link is biological.

Each parents row has an optional `kind`: empty means biological, or donor (a gamete donor, also genetic), surrogate, legal, adoptive or social (add your own
with `kinds`). Only biological links count for siblings, relatedness and genetics; the others, such as a foster dam,
are shown dotted and labelled. The Mother/Father pickers edit only the biological rows.

The plugin never creates collections for parents, roles, modes, graph edges or occurrences.

## Parent labels

Stored roles stay `mother` / `father`; only the words change. `terminology.parents` sets the
default (`'mother-father'` (default), `'dam-sire'`, `'female-male-parent'`, or custom
`{ maternal, paternal }`). Add `createParentTermsPreferenceField()` to your users collection
and pass its path as `terminology.userPreference`: each user then sees their own choice in the
Mother/Father pickers and in relatives.

## Cohorts are birthing events

A cohort is one birthing event (a clutch, a litter, twins): one mother, fathers may differ per
member. With `cohorts.birthParentField` (the cohort's field naming the mother), a member whose
recorded mother differs is refused, and so is changing the cohort's mother while members disagree.

These checks use only what the requester can read, so their answers are the same with or without
a hidden record: a mother, birthing parent, cohort or member the requester can't read is left out
of the comparison. The cost is that an editor can save a mother that differs from a hidden
birthing parent, or set a birthing parent that a hidden member contradicts. Server code with
access overridden is checked against everything. A hidden birthing parent comes back from plain
cohort reads as `{ "private": true }` (null in GraphQL, or with `hiddenRecords: 'omit'`), is kept
as stored when an editor saves the cohort, and a hidden birthing parent can't be probed through queries.
With access control on, sorting by a parent field (the cohort's birthing parent, `dam`, `sire`), listing its
distinct values and filtering below it are refused with a 400. `equals`, `in`, `not_equals` and `not_in` work only
with IDs the requester can read, so a hidden ID and a made-up one get the same answer. `exists` works only with
`hiddenRecords: 'placeholder'`. This covers versions, count, bulk update and delete, REST joins, and any path
that reaches a parent field through a relationship, from any collection in the host, including one a plugin
adds after this one (`animal.dam`, `mate.dam`, `animal.clutch.mother`), and a nested filter on a relationship (`herd[contains][dam][equals]`), which is checked against the related collection. A path of more than eight relationship hops
is refused, and so is an operand that is an object without an ID. Only paths that follow relationship fields are followed, so a host that stores a parent ID
in a plain text or JSON field has to guard that itself. Saving a
cohort with a birthing parent the editor can't read is refused.

## Integrity

On every write (Admin, REST, GraphQL, Local API, imports):

- self-parents, duplicated parents and **cycles** are rejected with field-addressable errors;
  the cycle check walks the full stored descendant line;
- a parent the editor **cannot read** is rejected, with the same message as a missing one;
- host `rules` (e.g. taxonomy) run on the proposed record;
- parentage changes are **serialized**: each updates a graph-revision global in the same
  transaction, so two concurrent edits that would together form a cycle cannot both commit
  (requires a MongoDB replica set or another adapter with transactions). The revision also
  serves as a cache key.

Deleting a recorded parent is refused (`onReferencedIndividualDelete: 'restrict'`, default) or
removes the references (`'detach'`).

## Endpoints

| Route | |
|---|---|
| `GET /api/<collection>/:id/pedigree?view=…` | Projection + layout; `ancestorDepth`, `descendantDepth`, `relatedId`, `cohortId`, `occurrenceMode`, `includeSiblings`, `orientation`, `maxNodes`, `layout=false` |
| `GET /api/<collection>/:id/relatives` | Parents, offspring, siblings (full / partial / unresolved), cohort mates |
| `POST /api/<collection>/:id/pedigree/validate` | Check `{ parents, reproductiveMode, cohort }` without saving (needs update access) |
| `GET /api/<cohorts>/:id/members` | Members the requester may see |

Every read runs as the requester (access control applies), is bounded by `limits`
(`maxDepth`, `maxNodes`) and returns display projections, not documents. Records the requester
cannot read are omitted or replaced by anonymous placeholders; their IDs, names and links never
appear in responses.

The same holds for plain collection reads (REST, GraphQL, the Admin, and the Local API with
`overrideAccess: false`), single or list, at any depth. A parent the reader can't read comes back as
`{ "private": true }` with `hiddenRecords: 'placeholder'`, or is left out with `'omit'`. GraphQL
returns `null` for it. Trusted Local API reads (the default `overrideAccess: true`) are unchanged.

Two answers still depend on records the requester can't read, and are accepted: the loop check
walks every descendant with full access (it only reports a loop through a parent the requester
can read, so a hidden record never shows in its message), and with `onReferencedIndividualDelete:
'restrict'`, deleting a recorded parent is refused with a 409 whether or not the children can be
read. The deleter needs delete access, and the alternative is a delete that orphans hidden records.
When someone saves a record that showed them a private parent, that parent is kept as stored: a
placeholder, an empty picker or a missing row means "unchanged", and replacing it with another
parent is refused. The kept parent also passes the parent field's validation, which would
otherwise look it up with the editor's access whenever the field has `filterOptions` (as the
multi-tenant plugin adds); other values are validated as usual.

Add an index on the parent path (`parentage.parents.individual`, or your
role fields) in production; the standard fields declare it.

## Admin

- A pedigree panel on the edit view: preview of the saved record in any view (pan, zoom,
  selection), relatives, and structural notices.
- A **Pedigree settings** global: color theme (seven presets, per-view accents, hex editing)
  used by the preview; read it in your frontend to match.

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0). Free for noncommercial use, with attribution; commercial use needs a separate license from EXTANT APE. Versions published before this change remain under MIT.
