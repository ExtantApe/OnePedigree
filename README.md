<picture><source media="(prefers-color-scheme: dark)" srcset="brand/oneorigin/marks/onepedigree-dark.svg"><img src="brand/oneorigin/marks/onepedigree-light.svg" alt="" width="96" height="96"></picture>

# OnePedigree

A species-neutral pedigree framework for humans and other animals (and plants): a portable
data model, graph validation, bounded ancestry traversal, view projections, automatic
layout, server-renderable React components and a Payload CMS plugin.

Part of the [OneOrigin suite](https://github.com/ExtantApe/OnePhylogeny/blob/main/docs/oneorigin/README.md): independent tools, with no subscriptions, that work alone or together.

> **Status: early alpha.** The packages are on npm as `0.1.0-alpha` versions, and the Mac app is on GitHub Releases. 285 automated tests pass:
> 112 in core, 57 in the React views, 51 in the Payload plugin, 49 in studbook and 16 in the Mac app. The studbook numbers
> are checked against textbook values, not yet against a real studbook or PMx run. The schema-version-1 file format is
> meant to stay; package APIs may still change. The Mac app isn't notarized.

| Package | Purpose |
|---|---|
| `@extantape/onepedigree-core` | Data model, normalization, validation, traversal, projections, layout, serialization. No React, Payload or database dependency. |
| `@extantape/onepedigree-react` | Server-renderable SVG views (all 13), interactive explorer, headless hooks, CSS-variable styling. |
| `@extantape/onepedigree-studbook` | Studbook records and analysis for managed populations: kinship, inbreeding, mean kinship, gene diversity, founder genome equivalents and studbook numbers, with an optional Payload endpoint. |
| `@extantape/payload-plugin-onepedigree` | Payload plugin: managed, standard or mapped collections, cycle-safe serialized writes, deletion policies, permission-aware endpoints, Admin preview and color settings. |

## Principles

- **Parentage lives on the individual**: `parentage.parents[{ individual, role }]`,
  `reproductiveMode` (`sexual`, `parthenogenesis`, `self`, `asexual`, `cloning`, `other`)
  and `cohort`. Children and siblings are derived, never stored.
- **Unknown stays unknown.** Roles are never inferred from sex; a missing parent or mode is
  not guessed; incomplete pedigrees are valid (they produce notices, not errors).
- **Bounded and cycle-safe.** Every traversal has depth and size limits and reports
  truncation; cycles are rejected.
- **Identity vs occurrence.** One stored individual may appear several times in a view;
  occurrences always map back to the one identity.

## Quick start

```ts
import { getAncestors, indexPedigree, validatePedigree, type PedigreeDocument } from '@extantape/onepedigree-core'

const pedigree: PedigreeDocument = {
  schemaVersion: 1,
  individuals: [
    { id: 'atlas', label: 'Atlas', sex: 'male' },
    { id: 'nova', label: 'Nova', sex: 'female' },
    {
      id: 'ember',
      label: 'Ember',
      parentage: {
        parents: [
          { individual: 'nova', role: 'mother' },
          { individual: 'atlas', role: 'father' },
        ],
        reproductiveMode: 'sexual',
      },
    },
  ],
}

const { valid, issues } = validatePedigree(pedigree)
const ancestors = getAncestors(indexPedigree(pedigree), 'ember', { maxGenerations: 4 })
```

Large datasets: implement `PedigreeRepository` (`getByIds`, `findChildrenOf`) and call
`loadNeighborhood()`; it loads a bounded neighborhood one query per generation.

## Views

`pedigree`, `fan`, `ahnentafel`, `descendants`, `hourglass`, `cohort`, `relationship`,
`timeline`, `inbreeding`, `population`, `compact`, `maternal`, `paternal`: each with a
projection (`projectPedigree`), a built-in deterministic layout (`layoutPedigree`; tree,
layered or radial, vertical or horizontal) and a React renderer. Custom layout engines (e.g.
ELK) plug in through `PedigreeLayoutEngine`.

For a list instead of a chart ("show all relatives"), `relativesByGeneration(projection)`
groups an hourglass projection's relatives by generation (parents, grandparents, …, siblings,
offspring, …); `generationKind()` gives hosts the kind and number of "great"s to translate, and
`generationLabel()` an English label.

## OnePedigree for Mac

A desktop app (`apps/desktop`, Tauri) for anyone, any species:

- **Open** a GEDCOM family tree (people), a OnePedigree `.json` file (any species), or a
  spreadsheet (CSV/TSV with ID, mother/dam and father/sire columns).
- **A GEDCOM is never changed.** Your extra fields and view settings live in a companion
  file beside it (`family.companion.json`), which follows the GEDCOM by its fingerprint.
  If a different file already has that name, the app leaves it alone and asks where else
  to keep your extras, beside the GEDCOM.
- **Build your own tree** for any species and save it as plain OnePedigree JSON (no special
  file type); export to GEDCOM or JSON at any time.
- Every pedigree view, colours, Mother/Father or Dam/Sire wording.
- **Updates itself** from GitHub releases (signed); turn it off in Settings.

### Install

Download the latest `.dmg` from this repository's [Releases](https://github.com/ExtantApe/OnePedigree/releases) page (tags `desktop-v*`) and drag OnePedigree to Applications. The app isn't notarized, so macOS blocks the first launch. Use either way past the warning:

- **System Settings:** try to open the app once, then go to System Settings > Privacy & Security, scroll down, click **Open Anyway**, and click **Open** when the warning comes back. Apple says to do this only for an app you trust.
- **Terminal:** `xattr -dr com.apple.quarantine "/Applications/OnePedigree.app"`

Builds: push a `desktop-v*` tag (`.github/workflows/desktop.yml`).

## Development

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build   # build also writes apps/playground/dist (gallery.html, index.html)
```

`apps/playground` shows every view for every fixture: `dist/gallery.html` (static, server-
rendered) and `dist/index.html` (interactive; serve the folder, e.g. `python3 -m http.server`).

## Part of the OneOrigin suite

OnePedigree works on its own or with the other OneOrigin tools: [OneTaxonomy](https://github.com/ExtantApe/OneTaxonomy), [OneLineage](https://github.com/ExtantApe/OneLineage) (coming soon), [OnePhylogeny](https://github.com/ExtantApe/OnePhylogeny) and [OneFamily](https://github.com/ExtantApe/OneFamily), which draws its family trees with OnePedigree's views. See [the suite](https://github.com/ExtantApe/OnePhylogeny/blob/main/docs/oneorigin/README.md) and its [guidelines](https://github.com/ExtantApe/OnePhylogeny/blob/main/docs/oneorigin/guidelines.md).

## Documentation

[Architecture](docs/architecture/architecture.md), [scientific invariants](docs/architecture/scientific-invariants.md), [changelog](CHANGELOG.md), [releasing](RELEASING.md).

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0). Free for noncommercial use, with attribution; commercial use needs a separate license from EXTANT APE. This license makes OnePedigree source-available. It isn't an open source license. Versions published under MIT before the license changed stay under MIT.
