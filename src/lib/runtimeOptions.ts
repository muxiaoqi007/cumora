import { http } from '@/api/client'

export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type PiThinkingLevel = typeof PI_THINKING_LEVELS[number]

export interface AgentRuntimeOptions {
  reasoningEffort?: string
  thinkingLevel?: PiThinkingLevel
}

export async function getAgentRuntimeOptions(agentId: string): Promise<AgentRuntimeOptions> {
  const result = await http<{ options?: AgentRuntimeOptions }>(
    `/agents/${encodeURIComponent(agentId)}/runtime-options`,
  )
  return result.options ?? {}
}

export async function putAgentRuntimeOptions(
  agentId: string,
  options: AgentRuntimeOptions,
): Promise<AgentRuntimeOptions> {
  const result = await http<{ ok: true; options: AgentRuntimeOptions }>(
    `/agents/${encodeURIComponent(agentId)}/runtime-options`,
    { method: 'PUT', body: JSON.stringify({ options }) },
  )
  return result.options
}
