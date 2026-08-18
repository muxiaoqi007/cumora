import { Router, type NextFunction, type Request, type Response } from 'express'
import { audit, authMiddleware, type AuthedRequest } from '../auth.js'
import { pool } from '../db/pool.js'
import { resolveDevice } from '../agents/computer/registry.js'
import { getAgentRuntimeOptions, setAgentRuntimeOptions } from '../agents/computer/runtime-options.js'

export const runtimeOptionsRouter = Router()
runtimeOptionsRouter.use(authMiddleware as never)

class RuntimeOptionsHttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

function safe(handler: (req: Request & AuthedRequest, res: Response) => Promise<void>) {
  return async (req: Request & AuthedRequest, res: Response, next: NextFunction) => {
    try { await handler(req, res) }
    catch (err) {
      if (err instanceof RuntimeOptionsHttpError) {
        res.status(err.status).json({ error: err.message })
        return
      }
      next(err)
    }
  }
}

function bearer(req: Request): string {
  const auth = req.headers.authorization
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
}

async function sessionCompany(req: Request & AuthedRequest): Promise<{ userId: string; companyId: string; role: string } | null> {
  const userId = req.authUserId
  if (!userId) return null
  const requested = typeof req.headers['x-company-id'] === 'string' ? req.headers['x-company-id'].trim() : ''
  const { rows } = await pool.query<{ company_id: string; role: string }>(
    requested
      ? `SELECT company_id, role FROM company_members WHERE user_id = $1 AND company_id = $2 LIMIT 1`
      : `SELECT company_id, role FROM company_members WHERE user_id = $1 ORDER BY joined_at ASC LIMIT 1`,
    requested ? [userId, requested] : [userId],
  )
  if (!rows[0]) throw new RuntimeOptionsHttpError(403, 'not a member of this workspace')
  return { userId, companyId: rows[0].company_id, role: rows[0].role }
}

async function assertAgent(agentId: string, companyId: string, computerId?: string | null): Promise<void> {
  const params: unknown[] = [agentId, companyId]
  let sql = `SELECT 1 FROM participants WHERE id = $1 AND company_id = $2 AND kind = 'agent' AND departed_at IS NULL`
  if (computerId) { params.push(computerId); sql += ` AND computer_id = $3` }
  sql += ' LIMIT 1'
  const { rows } = await pool.query(sql, params)
  if (!rows[0]) throw new RuntimeOptionsHttpError(404, 'agent not found on this computer')
}

/**
 * Human sessions and the paired daemon can read options. A device token may
 * only read agents currently assigned to that exact computer; this prevents a
 * leaked/revoked machine credential from becoming a workspace-wide config API.
 */
runtimeOptionsRouter.get('/agents/:id/runtime-options', safe(async (req, res) => {
  const agentId = String(req.params.id ?? '').trim()
  if (!agentId) throw new RuntimeOptionsHttpError(400, 'agent id required')

  const human = await sessionCompany(req)
  if (human) {
    await assertAgent(agentId, human.companyId)
    res.json({ options: await getAgentRuntimeOptions(agentId, human.companyId) })
    return
  }

  const device = await resolveDevice(bearer(req))
  if (!device) throw new RuntimeOptionsHttpError(401, 'authentication required')
  await assertAgent(agentId, device.companyId, device.computerId)
  res.json({ options: await getAgentRuntimeOptions(agentId, device.companyId) })
}))

/** Runtime configuration is a shared agent setting: owner/admin only. */
runtimeOptionsRouter.put('/agents/:id/runtime-options', safe(async (req, res) => {
  const agentId = String(req.params.id ?? '').trim()
  if (!agentId) throw new RuntimeOptionsHttpError(400, 'agent id required')
  const human = await sessionCompany(req)
  if (!human) throw new RuntimeOptionsHttpError(401, 'authentication required')
  if (human.role !== 'owner' && human.role !== 'admin') {
    throw new RuntimeOptionsHttpError(403, 'this action requires an owner or admin of the workspace')
  }
  await assertAgent(agentId, human.companyId)
  const options = await setAgentRuntimeOptions(agentId, human.companyId, req.body?.options ?? {})
  void audit({
    kind: 'agent_runtime_options_update',
    userId: human.userId,
    companyId: human.companyId,
    ip: req.socket.remoteAddress ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    detail: { agentId, options },
  })
  res.json({ ok: true, options })
}))
