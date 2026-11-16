/**
 * The same-origin HTTP routes the browser half calls.
 *
 * The browser half is plain page JavaScript: it reaches the Host with `fetch` on
 * its own origin, so this module registers the exact routes that `client.js`
 * posts to and hands each call to the same `sessionRollback` service `ctx.provide`
 * publishes.
 *
 * A rollback is one `prepare` followed by one `restore`, with the browser half's
 * native session fork in between; `state` answers whether a session can be rolled
 * back right now and which user messages its surface holds.
 *
 * Security follows the composition, not this plugin: every request first asks
 * `connection.requestRejection(req)`, which applies the Host/Origin fence and the
 * browser login-token authentication and answers 401 or 403. Only then is the
 * method checked (405 with the route's `Allow`), a POST body read under a size
 * ceiling (413) as `application/json` (415) holding a JSON object (400), and the
 * service called. Every rejection answers one `{ code, message }` shape, and an
 * unexpected throw answers `internal-error` with a fixed sentence so a stack or
 * an internal path never reaches the page.
 *
 * Registration is effect-owned: `webServer.register` returns the disposer that
 * removes the route, so unloading the plugin removes every route.
 *
 * @module dsh-session-rollback/host/api
 */

/** Route prefix of both endpoints. */
const BASE = '/session-rollback'

/** `POST` (and `GET`) whether a session can be rolled back, and what it holds. */
export const STATE_PATH = `${BASE}/state`

/** `POST` one rollback preparation: the fork cut and the composer write-back. */
export const PREPARE_PATH = `${BASE}/prepare`

/** `POST` the file restoration of the turns a fork rolled away. */
export const RESTORE_PATH = `${BASE}/restore`

/** `POST` the release of a preparation whose fork step failed. */
export const RELEASE_PATH = `${BASE}/release`

/** Two small field objects are all these routes carry; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/** One rejected request: the wrapper turns it into the uniform `{ code, message }` body. */
class ApiError extends Error {
  /**
   * @param {number} status HTTP status the wrapper answers with
   * @param {string} code stable refusal code the browser half maps to a sentence
   * @param {string} message developer-facing detail; never a stack or a path
   */
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload === undefined ? null : payload))
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} allow the route's `Allow` header value
 */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify({ code: 'method-not-allowed', message: `use ${allow}` }))
}

/**
 * Read one request header from either a plain node header bag or a Fetch `Headers`.
 * @param {{ headers?: unknown }} request
 * @param {string} name lowercase header name
 * @returns {string | undefined}
 */
function headerOf(request, name) {
  const headers = request?.headers
  if (headers === null || headers === undefined) return undefined
  const raw = typeof headers.get === 'function' ? headers.get(name) : headers[name]
  if (typeof raw === 'string') return raw
  return Array.isArray(raw) && typeof raw[0] === 'string' ? raw[0] : undefined
}

/**
 * Collect a bounded body as UTF-8 text; `null` past the ceiling (stream drained).
 * @param {AsyncIterable<Buffer | string> & { resume?: () => void }} req
 * @returns {Promise<string | null>}
 */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    size += bytes.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume?.()
      return null
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Parse a JSON object body. Arrays, primitives and malformed text are one rejection.
 * @param {string} text
 * @returns {Record<string, unknown> | undefined}
 */
function parseJsonObject(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return parsed
}

/**
 * Read one non-blank string field from a query record or a JSON body.
 * @param {Record<string, unknown> | undefined} source
 * @param {string} name
 * @returns {string | undefined}
 */
function stringField(source, name) {
  const value = source?.[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * @param {Record<string, unknown> | undefined} source
 * @param {string} name
 * @returns {string}
 */
function requiredString(source, name) {
  const value = stringField(source, name)
  if (value === undefined) throw new ApiError(400, 'missing-parameter', `"${name}" is required`)
  return value
}

/**
 * Parse one optional integer field; a present but non-integer value is a rejection.
 * @param {Record<string, unknown> | undefined} source
 * @param {string} name
 * @param {number} min smallest accepted value
 * @returns {number | undefined}
 */
function intField(source, name, min) {
  const raw = source?.[name]
  if (raw === undefined || raw === null || raw === '') return undefined
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(value)) throw new ApiError(400, 'bad-parameter', `"${name}" must be an integer`)
  if (value < min) throw new ApiError(400, 'bad-parameter', `"${name}" must be >= ${min}`)
  return value
}

/**
 * The `Allow` header of one route.
 * @param {{ GET?: Function, POST?: Function }} route
 * @returns {string}
 */
function allowedMethods(route) {
  if (typeof route.GET === 'function' && typeof route.POST === 'function') return 'GET, POST'
  return typeof route.GET === 'function' ? 'GET' : 'POST'
}

/**
 * Wrap one route: trust fence, method, body, then the handler.
 * @param {{ path: string, GET?: Function, POST?: Function }} route
 * @param {object} connection the composition's `connection` service
 * @param {{ warn?: Function }} logger
 * @returns {(req: object, res: object) => Promise<void>}
 */
function wrapRoute(route, connection, logger) {
  return async (req, res) => {
    try {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        sendJson(res, rejection, {
          code: rejection === 403 ? 'forbidden' : 'unauthorized',
          message: 'this request is not authorized',
        })
        return
      }
      const method = req.method === 'GET' || req.method === 'POST' ? req.method : undefined
      const handler = method === undefined ? undefined : route[method]
      if (typeof handler !== 'function') {
        sendMethodNotAllowed(res, allowedMethods(route))
        return
      }
      const url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://localhost')
      const query = Object.fromEntries(url.searchParams)
      let body
      if (method === 'POST') {
        const mediaType = String(headerOf(req, 'content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase()
        if (mediaType !== 'application/json') {
          throw new ApiError(415, 'unsupported-media-type', 'content-type must be application/json')
        }
        const text = await readBoundedBody(req)
        if (text === null) throw new ApiError(413, 'payload-too-large', 'request body is too large')
        body = parseJsonObject(text)
        if (body === undefined) throw new ApiError(400, 'bad-request', 'request body must be a JSON object')
      }
      await handler(req, res, query, body)
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(res, error.status, { code: error.code, message: error.message })
        return
      }
      // The page gets a fixed sentence; the stack stays in the Host log.
      logger.warn?.(`session-rollback: ${route.path} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      sendJson(res, 500, { code: 'internal-error', message: 'the request could not be completed' })
    }
  }
}

/**
 * Register every route on the composition's `webServer`.
 *
 * `ctx` must be the Context that carries `webServer` and `connection` (the child
 * Context `ctx.inject(['webServer', 'connection'], ...)` provides), and `service`
 * must be the instance `ctx.provide` publishes, so the routes and the published
 * service can never drift apart.
 *
 * @param {object} options
 * @param {object} options.ctx Context carrying `webServer` and `connection`
 * @param {object} options.service the `sessionRollback` service (`state`, `prepare`, `restore`, `release`)
 * @param {{ warn?: Function }} [options.logger]
 * @returns {boolean} whether every route was registered
 */
export function registerRollbackApi({ ctx, service, logger = console }) {
  const webServer = ctx.get?.('webServer') ?? ctx.webServer
  const connection = ctx.get?.('connection') ?? ctx.connection
  if (webServer === undefined || connection === undefined) {
    logger.warn?.('session-rollback: webServer/connection are unavailable; the page cannot reach the rollback service')
    return false
  }
  if (service === undefined || service === null
    || typeof service.state !== 'function'
    || typeof service.prepare !== 'function'
    || typeof service.restore !== 'function'
    || typeof service.release !== 'function') {
    logger.warn?.('session-rollback: the rollback service is unavailable; the page cannot reach it')
    return false
  }

  /** @type {{ path: string, GET?: Function, POST?: Function }[]} */
  const routes = [
    {
      path: STATE_PATH,
      async GET(_req, res, query) {
        sendJson(res, 200, await service.state(requiredString(query, 'sessionId')))
      },
      async POST(_req, res, _query, body) {
        sendJson(res, 200, await service.state(requiredString(body, 'sessionId')))
      },
    },
    {
      path: PREPARE_PATH,
      async POST(_req, res, _query, body) {
        /** Only the fields the service accepts; unknown keys never reach it. */
        const request = { sessionId: requiredString(body, 'sessionId') }
        const seq = intField(body, 'seq', 0)
        const ordinal = intField(body, 'ordinal', 1)
        const index = intField(body, 'index', 0)
        if (seq !== undefined) request.seq = seq
        if (ordinal !== undefined) request.ordinal = ordinal
        if (index !== undefined) request.index = index
        sendJson(res, 200, await service.prepare(request))
      },
    },
    {
      path: RESTORE_PATH,
      async POST(_req, res, _query, body) {
        const request = { sessionId: requiredString(body, 'sessionId') }
        const childSessionId = stringField(body, 'childSessionId')
        const turn = intField(body, 'turn', 0)
        if (childSessionId !== undefined) request.childSessionId = childSessionId
        if (turn !== undefined) request.turn = turn
        sendJson(res, 200, await service.restore(request))
      },
    },
    {
      path: RELEASE_PATH,
      async POST(_req, res, _query, body) {
        sendJson(res, 200, service.release({ sessionId: requiredString(body, 'sessionId') }))
      },
    },
  ]

  for (const route of routes) {
    const handler = wrapRoute(route, connection, logger)
    const register = () => webServer.register({ kind: 'exact', path: route.path, handler })
    if (typeof ctx.effect === 'function') ctx.effect(register, `session-rollback: ${route.path}`)
    else register()
  }
  return true
}
