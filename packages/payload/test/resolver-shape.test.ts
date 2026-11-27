import { buildVersionCollectionFields, getLocalizedPaths } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startFixture, type Ctx } from './differential.fixture'

/**
 * What the query guard relies on in Payload's `getLocalizedPaths` (pinned to the 3.92 line by the peer range). If a
 * Payload release changes any of these, this file fails before the guard quietly stops seeing a parent field.
 */
describe('getLocalizedPaths shape', () => {
  let c: Ctx
  beforeAll(async () => {
    c = await startFixture('omit')
  })
  afterAll(async () => {
    await c?.stop()
  })

  const resolve = (slug: string, key: string, version = false, locale: string | undefined = 'en') => {
    const config = c.payload.collections[slug as never]!.config
    const fields = version ? buildVersionCollectionFields(c.payload.config, config, true) : config.flattenedFields
    return getLocalizedPaths({ collectionSlug: slug, fields, incomingPath: key, locale, overrideAccess: false, payload: c.payload, showHiddenFields: false })
  }
  const summary = (slug: string, key: string, version = false, locale?: string) =>
    resolve(slug, key, version, locale).map((e) => `${e.collectionSlug}:${(e.field as { name?: string } | undefined)?.name}:${e.path}:${e.invalid ? 'invalid' : ''}${e.complete ? 'complete' : ''}`)

  it('gives one entry per collection a key passes through', () => {
    expect(summary('weighings', 'animal')).toEqual(['weighings:animal:animal:complete'])
    expect(summary('weighings', 'animal.dam')).toEqual(['weighings:animal:animal:complete', 'animals:dam:dam:complete'])
    expect(summary('weighings', 'animal.clutch.mother')).toEqual(['weighings:animal:animal:complete', 'animals:clutch:clutch:complete', 'clutches:mother:mother:complete'])
    expect(summary('weighings', 'herd.dam')).toEqual(['weighings:herd:herd:complete', 'animals:dam:dam:complete'])
  })

  it('consumes locale codes, groups, arrays, blocks and tabs into the entry path', () => {
    expect(summary('weighings', 'lherd.en')).toEqual(['weighings:lherd:lherd.en:complete'])
    expect(summary('weighings', 'lherd')).toEqual(['weighings:lherd:lherd.en:complete'])
    expect(summary('weighings', 'lgrp.en.herd')).toEqual(['weighings:herd:lgrp.en.herd:complete'])
    expect(summary('weighings', 'lgrp.en.herd.dam')).toEqual(['weighings:herd:lgrp.en.herd:complete', 'animals:dam:dam:complete'])
    expect(summary('weighings', 'items.animal.dam')).toEqual(['weighings:animal:items.animal:complete', 'animals:dam:dam:complete'])
    expect(summary('weighings', 'layout.animal.dam')).toEqual(['weighings:animal:layout.animal:complete', 'animals:dam:dam:complete'])
    expect(summary('weighings', 'meta.animal.dam')).toEqual(['weighings:animal:meta.animal:complete', 'animals:dam:dam:complete'])
  })

  it('drops the segment after a locale code on a relationship (Payload skips one segment too many)', () => {
    // Pinned on purpose: the guard classifies what the database builder will run, and both read this same function.
    expect(summary('weighings', 'lherd.en.dam')).toEqual(['weighings:lherd:lherd.en:complete'])
  })

  it('marks polymorphic paths and unknown keys invalid', () => {
    expect(summary('weighings', 'subject.value.dam')).toEqual(['weighings:undefined:subject.value.dam.value:invalid'])
    expect(summary('weighings', 'nope')).toEqual(['weighings:undefined:nope:invalid'])
    expect(summary('animals', 'my.kids.dam')).toEqual(['animals:undefined:my:invalid'])
  })

  it('resolves join names and version fields', () => {
    expect(summary('animals', 'kids.dam')).toEqual(['animals:kids:kids:complete', 'animals:dam:dam:complete'])
    expect(summary('weighings', 'version.animal.dam', true)).toEqual(['weighings:animal:version.animal:complete', 'animals:dam:dam:complete'])
    expect(summary('weighings', 'version.lherd.en', true)).toEqual(['weighings:lherd:version.lherd.en:complete'])
  })

  it('returns the field objects that sit in the collection field lists', () => {
    const animals = c.payload.collections.animals!.config.flattenedFields
    const dam = animals.find((f) => f.name === 'dam')
    expect(resolve('weighings', 'animal.dam')[1]!.field).toBe(dam)
    const wf = c.payload.collections.weighings!.config.flattenedFields
    expect(resolve('weighings', 'animal.dam')[0]!.field).toBe(wf.find((f) => f.name === 'animal'))
    const clutches = c.payload.collections.clutches!.config.flattenedFields
    expect(resolve('weighings', 'animal.clutch.mother')[2]!.field).toBe(clutches.find((f) => f.name === 'mother'))
  })
})
