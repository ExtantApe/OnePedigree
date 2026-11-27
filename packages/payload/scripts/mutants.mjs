// Mutation check for the hidden-parents guard. Not shipped. Run: node scripts/mutants.mjs [id ...]
// Each mutant changes one line of src, runs the tests that must notice, and restores the file. A mutant that
// passes every test is a gap. Every id below is killed by the named files (see the CHANGELOG for the mapping).
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const T = {
  omit: 'test/hidden-parent-differential-omit.test.ts',
  placeholder: 'test/hidden-parent-differential-placeholder.test.ts',
  installed: 'test/guard-installed.test.ts',
  limits: 'test/guard-limits.test.ts',
  noinit: 'test/guard-noinit.test.ts',
  std: 'test/differential-standard-omit.test.ts',
}
const both = [T.omit, T.placeholder]
const P = 'src/parentPaths.ts'
const V = 'src/privacy.ts'
const G = 'src/globalGuard.ts'
const L = 'src/plugin.ts'
/** [id, file, find, replace, tests] */
const mutants = [
  ['M01 no _id and __ normalizing (raw key lookup)', P, "const normalize = (raw: string): string => (raw === '_id' ? 'id' : raw.replace(/__/g, '.'))", 'const normalize = (raw: string): string => raw', [...both, T.std]],
  ['M02 only _id normalized, __ left alone', P, "raw.replace(/__/g, '.'))", 'raw)', [...both, T.std]],
  ['M03 compare by key text, not field identity (no locale clean-up)', P, 'if (e.field && guarded.has(e.field)) hit = strongest(hit, i === entries.length - 1 ? \'exact\' : \'below\')', "if (guardedPaths(opts, e.collectionSlug ?? slug).includes(raw)) hit = strongest(hit, 'exact')", [...both, T.std]],
  ['M04 version fields left out of the field sets', P, "if (v && (operation === 'read' || operation === 'countVersions')) sets.push", 'if (false && v) sets.push', [T.omit, T.installed]],
  ['M05 version prefix not applied to the guarded fields', P, "set.version ? ['version'] : []", '[]', [T.omit, T.installed]],
  ['M06 invalid entries accepted', P, 'if (entries.some((e) => e.invalid || !e.field)) continue', 'if (entries.some((e) => !e.field)) continue', [T.limits]],
  ['M07 hop limit removed', P, 'entries.length > MAX_ENTRIES', 'false', [T.limits]],
  ['M08 below treated as exact', P, "i === entries.length - 1 ? 'exact' : 'below'", "'exact'", both],
  ['M09 exact treated as below', P, "i === entries.length - 1 ? 'exact' : 'below'", "'below'", both],
  ['M10 unresolved key not refused', V, 'if (e instanceof Unresolved) throw refused()', 'if (e instanceof Unresolved) return args', [T.limits, ...both]],
  ['M11 sort not checked', V, 'for (const k of sortKeys(sort)) if (strongestHit(resolve(slug, op, k))) throw refused()', '', both],
  ['M12 distinct field not checked', V, "if (typeof a.field === 'string' && strongestHit(resolve(slug, operation, a.field))) throw refused()", '', both],
  ['M13 sort keys keep their leading minus', V, ".replace(/^[-+\\s]+/, '')", '', both],
  ['M14 and/or matched in lower case only', V, "(k.toLowerCase() === 'and' || k.toLowerCase() === 'or')", "(k === 'and' || k === 'or')", both],
  ['M15 nesting depth not limited', V, 'if (depth > MAX_DEPTH) throw refused()', '', [T.limits]],
  ['M16 nested contains not walked', V, "if (o === 'contains' && isObj(operand) && nested.length) {", 'if (false) {', both],
  ['M17 object operands on relationships accepted', V, "!simpleRef(x)) throw refused()", 'false) throw refused()', both],
  ['M18 relationship fields not recognised as relational', V, "const relational = last.some((f) => RELATIONAL.has(f.type ?? ''))", 'const relational = false', both],
  ['M19 joins not checked', V, "if (a.joins && typeof a.joins === 'object') {", 'if (false) {', both],
  ['M20 join name rewritten like a where key (dotted join name)', V, 'list.some((x) => x.joinPath === name)', "list.some((x) => x.joinPath === name.replace(/__/g, '.'))", both],
  ['M21 unknown join name accepted', V, 'if (!targets.length) throw refused()', 'if (!targets.length) continue', both],
  ['M22 join where not checked against its target', V, "check(t, 'update', jq.where, jq.sort)", 'void t', both],
  ['M23 exists allowed in omit mode', V, "if (opts.hiddenRecords !== 'placeholder') throw refused()\n              continue", 'continue', [T.omit]],
  ['M24 hidden ids not checked', V, 'if (ids.some((id) => !ok.has(id))) throw refused()', '', both],
  ['M25 countVersions not guarded', V, "'readDistinct', 'update', 'delete', 'countVersions'", "'readDistinct', 'update', 'delete'", [T.installed]],
  ['M26 bulk update and delete not guarded', V, "'count', 'readDistinct', 'update', 'delete'", "'count', 'readDistinct'", both],
  ['M27 trusted callers checked too', V, 'a.overrideAccess === true || ', '', [T.installed]],
  ['M28 global versions not guarded (hook only)', L, '(opts.disabled ? g : guardGlobalVersions(g, opts))', 'g', [T.installed, ...both]],
  ['M29 late globals not guarded', L, 'guardGlobalVersions(g, opts, true)', 'void g', [T.installed, T.noinit]],
  ['M30 late collections not guarded at database start', L, 'init: (args: { payload: Payload }) => (installLate(args.payload), host.init!(args))', 'init: (args: { payload: Payload }) => host.init!(args)', [T.noinit]],
  ['M31 no global is exposed', G, 'if (exposed(req.payload, opts, config as never) && ', 'if (false && ', [T.installed, ...both]],
  ['M32 every global is exposed', G, 'if (exposed(req.payload, opts, config as never) && ', 'if (true && ', [T.installed]],
  ['M33 callers who read everything are refused too', G, '&& !(await readsEveryIndividual(req, opts))', '', [T.installed]],
  ['M34 callers who read part are let through', G, '&& !(await readsEveryIndividual(req, opts))', '&& false', [T.installed, ...both]],
  ['M35 exposure only direct, never through other collections', G, 'const r = [...targetsOf(config.flattenedFields, payload)].some((t) => collectionReaches(t, next))', 'const r = false', [T.installed]],
]

const only = process.argv.slice(2)
const tmp = mkdtempSync(join(tmpdir(), 'mutants-'))
let failed = 0
try {
  for (const [id, file, find, replace, tests] of mutants) {
    if (only.length && !only.some((o) => id.startsWith(o))) continue
    const path = join(root, file)
    const original = readFileSync(path, 'utf8')
    const parts = original.split(find)
    if (parts.length !== 2) {
      console.log(`${id}: NOT APPLIED (found ${parts.length - 1} matches)`)
      failed++
      continue
    }
    const backup = join(tmp, 'backup.ts')
    copyFileSync(path, backup)
    try {
      writeFileSync(path, parts.join(replace))
      const out = join(tmp, 'result.json')
      const r = spawnSync('pnpm', ['vitest', 'run', ...tests, '--reporter=json', `--outputFile=${out}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] })
      let names = []
      try {
        const j = JSON.parse(readFileSync(out, 'utf8'))
        names = j.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === 'failed').map((a) => a.title))
      } catch {}
      const killed = r.status !== 0
      if (!killed) failed++
      console.log(`${id}: ${killed ? 'killed by ' + (names.slice(0, 2).join(' | ').slice(0, 110) || 'a failing test file') : 'SURVIVED'}`)
    } finally {
      copyFileSync(backup, path)
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
