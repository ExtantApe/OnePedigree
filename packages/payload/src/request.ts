import { isolateObjectProperty, type PayloadRequest } from 'payload'

/**
 * A request for one of the plugin's own nested reads or writes. It shares the caller's user, headers, locale and
 * transaction, and has its own `context` (a copy of the caller's, plus `context`) and its own data loader.
 *
 * Payload merges a nested call's `context` into the request it's given and leaves it there, and it runs the documents
 * of a bulk update in parallel on one request. A flag the plugin set on the caller's request would therefore reach
 * sibling documents and later calls, and switch their checks or redaction off. The fresh data loader keeps documents
 * read with stored parent IDs out of the caller's cache.
 */
export function childReq(req: PayloadRequest, context: Record<string, unknown> = {}): PayloadRequest {
  const child = isolateObjectProperty(req, ['context', 'payloadDataLoader'])
  child.context = { ...req.context, ...context }
  ;(child as { payloadDataLoader?: unknown }).payloadDataLoader = undefined
  return child
}
