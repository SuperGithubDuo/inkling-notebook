/**
 * A local stand-in for a Supabase project, for acceptance tests: the parts of
 * its HTTP API that Inkling uses (email-code sign-in, the docs table and
 * push_doc through PostgREST, the assets bucket). It applies the same rules
 * as supabase/migrations — rows belong to the token's user, writes need the
 * current revision — which are tested against real Postgres in
 * tests/unit/supabaseSchema.test.ts.
 *
 * Any email signs in with the code 123456.
 */
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const uidOf = (email) => {
  const h = createHash('sha256').update(email).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export async function startFakeSupabase({ port = 0 } = {}) {
  /** user id → Map(path → row) */
  const docs = new Map()
  const versions = []
  const assets = new Map()
  const tokens = new Map()
  const requests = []
  let seq = 0
  let down = false

  const session = (email) => {
    const user = { id: uidOf(email), aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
    const exp = Math.floor(Date.now() / 1000) + 3600
    const access_token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, email, role: 'authenticated', aud: 'authenticated', exp, jti: randomUUID() })}.test`
    const refresh_token = randomUUID()
    tokens.set(access_token, user)
    tokens.set(refresh_token, user)
    return { access_token, refresh_token, token_type: 'bearer', expires_in: 3600, expires_at: exp, user }
  }
  const rowsOf = (uid) => docs.get(uid) ?? docs.set(uid, new Map()).get(uid)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const cors = {
      'access-control-allow-origin': req.headers.origin ?? '*',
      'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'access-control-expose-headers': 'content-range'
    }
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { ...cors, 'content-type': type })
      res.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body))
    }
    if (req.method === 'OPTIONS') return send(204)
    if (down) return req.destroy()
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks)
    const json = () => JSON.parse(raw.toString('utf8') || '{}')
    requests.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization ?? '' })
    const user = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''))
    const path = url.pathname

    // ---- auth
    if (path === '/auth/v1/otp') return send(200, {})
    if (path === '/auth/v1/verify') {
      const { email, token } = json()
      return token === '123456' && email ? send(200, session(email)) : send(403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' })
    }
    if (path === '/auth/v1/token') {
      const known = tokens.get(json().refresh_token)
      return known ? send(200, session(known.email)) : send(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' })
    }
    if (path === '/auth/v1/user') return user ? send(200, user) : send(401, { msg: 'invalid JWT' })
    if (path === '/auth/v1/logout') return send(204)

    // Everything below is the signed-in user's own data, as row-level security enforces.
    if (!user) return send(401, { message: 'JWT expired', code: 'PGRST301' })
    const mine = rowsOf(user.id)

    if (path === '/rest/v1/rpc/push_doc') {
      const p = json()
      if (!/^(library|(page|note)\/[A-Za-z0-9_-]{6,64}\/[A-Za-z0-9_-]{6,64})$/.test(p.p_path)) return send(400, { message: 'violates check constraint' })
      const cur = mine.get(p.p_path)
      if ((cur?.rev ?? 0) !== p.p_base_rev) return send(200, { ok: false, current: cur ? { path: cur.path, rev: cur.rev, seq: cur.seq, deleted: cur.deleted, content: cur.content } : null })
      if (cur?.content && (p.p_keep_version || cur.device !== p.p_device)) versions.push({ id: randomUUID(), user: user.id, path: cur.path, rev: cur.rev, content: cur.content, device: cur.device, created_at: new Date().toISOString() })
      mine.set(p.p_path, { path: p.p_path, rev: p.p_base_rev + 1, seq: ++seq, deleted: p.p_deleted, content: p.p_deleted ? null : p.p_content, device: p.p_device })
      return send(200, { ok: true, rev: p.p_base_rev + 1 })
    }
    if (path === '/rest/v1/docs') {
      const q = url.searchParams
      const cols = (q.get('select') ?? '').split(',')
      let rows = [...mine.values()]
      if (q.get('path')?.startsWith('eq.')) rows = rows.filter((r) => r.path === q.get('path').slice(3))
      if (q.get('path')?.startsWith('neq.')) rows = rows.filter((r) => r.path !== q.get('path').slice(4))
      if (q.get('seq')?.startsWith('gt.')) rows = rows.filter((r) => r.seq > Number(q.get('seq').slice(3)))
      rows = rows.sort((a, b) => a.seq - b.seq).slice(0, Number(q.get('limit') ?? 1000))
      return send(200, rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))))
    }
    if (path === '/rest/v1/doc_versions') {
      const q = url.searchParams
      let rows = versions.filter((v) => v.user === user.id)
      if (q.get('path')?.startsWith('eq.')) rows = rows.filter((v) => v.path === q.get('path').slice(3))
      if (q.get('id')?.startsWith('eq.')) rows = rows.filter((v) => v.id === q.get('id').slice(3))
      return send(200, rows.reverse().map(({ user: _u, ...v }) => v))
    }
    const object = /^\/storage\/v1\/object\/assets\/(.+)$/.exec(path)?.[1]
    if (object) {
      // The bucket's policies: only under the user's own folder; add and read, never replace.
      if (!object.startsWith(`${user.id}/`)) return send(400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' })
      if (req.method === 'POST') {
        if (assets.has(object)) return send(400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' })
        const type = req.headers['content-type'] ?? ''
        // supabase-js sends a Blob/File as multipart and raw bytes as the body.
        assets.set(object, type.startsWith('multipart/') ? multipartFile(raw, type) : raw)
        return send(200, { Key: `assets/${object}` })
      }
      return assets.has(object) ? send(200, assets.get(object), 'application/octet-stream') : send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' })
    }
    send(404, { message: `fake Supabase: no ${req.method} ${path}` })
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    anonKey: 'test-anon-key',
    uidOf,
    docsOf: (email) => rowsOf(uidOf(email)),
    versions,
    assets,
    requests,
    /** Simulates the server being unreachable (connections are dropped). */
    setDown: (v) => void (down = v),
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(r)))
  }
}

function multipartFile(raw, type) {
  const boundary = Buffer.from(`--${/boundary=(.+)$/.exec(type)[1]}`)
  const start = raw.indexOf('\r\n\r\n', raw.indexOf(boundary)) + 4
  return raw.subarray(start, raw.indexOf(boundary, start) - 2)
}
