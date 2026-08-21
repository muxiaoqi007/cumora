import { useEffect, useState } from 'react'
import { api, getServerOrigin, type AgentInput } from '@/api/client'
import { isNativePlatform } from '@/lib/native'
import { runtimeDefinition, runtimeLabel } from '@/lib/runtimeCatalog'
import { getLocalRuntimeModelBridge, type LocalRuntimeModel } from '@/lib/localRuntimeModels'
import { getAgentRuntimeOptions, putAgentRuntimeOptions, PI_THINKING_LEVELS, type PiThinkingLevel } from '@/lib/runtimeOptions'
import type { LocalRuntimeStatus } from '@/lib/runtime'
import { useParticipants } from '@/stores/participants'
import { useComputers } from '@/stores/computers'
import { useConversations } from '@/stores/conversations'
import { useAuth } from '@/stores/auth'
import { Combobox } from '@/components/Combobox'
import { Input } from '@/components/Input'
import { TextArea } from '@/components/TextArea'
import { Select } from '@/components/Select'
import type { Participant, EngineId } from '@/types'

const PALETTE = [
  '#FFB088', '#FFD9D2', '#FFB7AF', '#F4B740',
  '#7C5CFF', '#A593FF', '#4FC2F4', '#41B5DC',
  '#4FC2A1', '#6EC56A', '#E9A0E9', '#FF7AB6',
]

interface Props {
  agent: Participant | null
  onClose: () => void
}

export function AgentEditor({ agent, onClose }: Props) {
  const editing = agent !== null
  const [name, setName] = useState(agent?.name ?? '')
  const [role, setRole] = useState(agent?.role ?? '')
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '')
  const [bio, setBio] = useState(agent?.bio ?? '')
  const [avatarBg, setAvatarBg] = useState(agent?.avatarBg ?? PALETTE[0])
  const [model, setModel] = useState(agent?.model ?? '')
  const [fastModel, setFastModel] = useState(agent?.fastModel ?? '')
  const [reasoningEffort, setReasoningEffort] = useState('')
  const [thinkingLevel, setThinkingLevel] = useState<PiThinkingLevel | ''>('')
  const [runtimeOptionsBusy, setRuntimeOptionsBusy] = useState(false)
  const [runtimeOptionsErr, setRuntimeOptionsErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(agent?.avatarUrl ?? null)
  const [generatingAvatar, setGeneratingAvatar] = useState(false)
  const [avatarErr, setAvatarErr] = useState<string | null>(null)
  const [repairCode, setRepairCode] = useState<string | null>(null)
  const [repairErr, setRepairErr] = useState<string | null>(null)
  const [repairCopied, setRepairCopied] = useState(false)
  const [localRuntimeStatus, setLocalRuntimeStatus] = useState<LocalRuntimeStatus | null>(null)
  const [localRuntimeBusy, setLocalRuntimeBusy] = useState(false)
  const [localRuntimeErr, setLocalRuntimeErr] = useState<string | null>(null)
  const [runtimeModels, setRuntimeModels] = useState<LocalRuntimeModel[]>([])
  const [runtimeModelsBusy, setRuntimeModelsBusy] = useState(false)
  const [runtimeModelsErr, setRuntimeModelsErr] = useState<string | null>(null)
  const [customModelMode, setCustomModelMode] = useState(false)
  const [customFastModelMode, setCustomFastModelMode] = useState(false)

  const activeTier = useAuth((s) => s.companies.find((c) => c.id === s.activeCompanyId)?.tier)
  const isFreeTier = activeTier === 'free'
  const computersById = useComputers((s) => s.byId)
  const computers = Object.values(computersById)
    .sort((a, b) => (a.kind === 'cloud' ? 0 : 1) - (b.kind === 'cloud' ? 0 : 1) || a.name.localeCompare(b.name))
  const cloud = computers.find((c) => c.kind === 'cloud')
  const firstByoa = computers.find((c) => c.kind !== 'cloud')
  const [computerId, setComputerId] = useState(agent?.computerId ?? (isFreeTier ? firstByoa?.id : cloud?.id) ?? '')
  const [engine, setEngine] = useState<EngineId>(() => {
    const saved = agent?.engine as EngineId | undefined
    if (saved && saved !== 'managed') return saved
    const host = agent?.computerId ? computersById[agent.computerId] : undefined
    if (host && host.kind !== 'cloud') {
      if (host.availableEngines.includes('claude')) return 'claude'
      return (host.availableEngines[0] as EngineId) ?? 'claude'
    }
    return saved ?? 'managed'
  })
  const selectedComputer = computerId ? computersById[computerId] : undefined
  const isByoa = !!selectedComputer && selectedComputer.kind !== 'cloud'
  const selectedComputerOffline = isByoa && selectedComputer.status !== 'online'
  const runtime = runtimeDefinition(engine)
  const origin = getServerOrigin()
  const repairCommand = repairCode
    ? `npx cumora@latest agent computer --pair ${repairCode}${origin ? ` --server ${origin}` : ''}`
    : ''
  const localRuntimeBridge = typeof window !== 'undefined' ? window.cumora?.localRuntime : undefined
  const localRuntimeModelBridge = getLocalRuntimeModelBridge()
  const localComputerVisible = !!localRuntimeStatus?.computerId && !!computersById[localRuntimeStatus.computerId]
  const canDiscoverModels = isByoa
    && engine !== 'managed'
    && runtime.modelDiscovery === 'local-catalog'
    && !!localRuntimeModelBridge
    && localRuntimeStatus?.computerId === selectedComputer?.id
  const selectedMainModel = runtimeModels.find((item) => item.id === model)
  const codexEfforts = selectedMainModel?.reasoningEfforts ?? []

  useEffect(() => { void useComputers.getState().refresh() }, [])
  useEffect(() => {
    if (!localRuntimeBridge) return
    let cancelled = false
    void localRuntimeBridge.status()
      .then((status) => { if (!cancelled) setLocalRuntimeStatus(status) })
      .catch((e) => { if (!cancelled) setLocalRuntimeErr(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!agent?.id) return
    let cancelled = false
    setRuntimeOptionsBusy(true)
    setRuntimeOptionsErr(null)
    void getAgentRuntimeOptions(agent.id)
      .then((options) => {
        if (cancelled) return
        setReasoningEffort(options.reasoningEffort ?? '')
        setThinkingLevel(options.thinkingLevel ?? '')
      })
      .catch((e) => {
        if (!cancelled) setRuntimeOptionsErr(e instanceof Error ? e.message : String(e))
      })
      .finally(() => { if (!cancelled) setRuntimeOptionsBusy(false) })
    return () => { cancelled = true }
  }, [agent?.id])

  useEffect(() => {
    setRepairCopied(false)
    setRepairErr(null)
    setRepairCode(null)
    if (!selectedComputerOffline || !selectedComputer) return
    let cancelled = false
    void api.repairComputer(selectedComputer.id)
      .then((out) => { if (!cancelled) setRepairCode(out.code) })
      .catch((e) => { if (!cancelled) setRepairErr(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [selectedComputer?.id, selectedComputerOffline])

  useEffect(() => {
    if (!repairCopied) return
    const t = window.setTimeout(() => setRepairCopied(false), 1600)
    return () => window.clearTimeout(t)
  }, [repairCopied])

  useEffect(() => {
    if (computerId) return
    if (isFreeTier && firstByoa) {
      setComputerId(firstByoa.id)
      setEngine((firstByoa.availableEngines.includes('claude') ? 'claude' : firstByoa.availableEngines[0] as EngineId) ?? 'claude')
    } else if (!isFreeTier && cloud) {
      setComputerId(cloud.id)
      setEngine('managed')
    }
  }, [cloud, firstByoa, computerId, isFreeTier])

  useEffect(() => {
    if (!selectedComputer || selectedComputer.kind === 'cloud') return
    if (engine === 'managed' || !selectedComputer.availableEngines.includes(engine)) {
      const next = (selectedComputer.availableEngines.includes('claude')
        ? 'claude'
        : selectedComputer.availableEngines[0]) as EngineId
      if (next && next !== engine) setEngine(next)
    }
  }, [selectedComputer?.id, selectedComputer?.kind, selectedComputer?.availableEngines, engine])

  const loadRuntimeModels = async (): Promise<void> => {
    if (!canDiscoverModels || !localRuntimeModelBridge) return
    setRuntimeModelsBusy(true)
    setRuntimeModelsErr(null)
    try {
      const result = await localRuntimeModelBridge.models(engine)
      if (!result.ok) throw new Error(result.error)
      setRuntimeModels(result.models)
      setCustomModelMode(!!model && !result.models.some((m) => m.id === model))
      setCustomFastModelMode(!!fastModel && !result.models.some((m) => m.id === fastModel))
    } catch (e) {
      setRuntimeModels([])
      setRuntimeModelsErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRuntimeModelsBusy(false)
    }
  }

  useEffect(() => {
    setRuntimeModels([])
    setRuntimeModelsErr(null)
    setRuntimeModelsBusy(false)
    if (!canDiscoverModels) return
    let cancelled = false
    setRuntimeModelsBusy(true)
    void localRuntimeModelBridge!.models(engine as Exclude<EngineId, 'managed'>)
      .then((result) => {
        if (cancelled) return
        if (!result.ok) throw new Error(result.error)
        setRuntimeModels(result.models)
        setCustomModelMode(!!model && !result.models.some((m) => m.id === model))
        setCustomFastModelMode(!!fastModel && !result.models.some((m) => m.id === fastModel))
      })
      .catch((e) => { if (!cancelled) setRuntimeModelsErr(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setRuntimeModelsBusy(false) })
    return () => { cancelled = true }
    // Deliberately keyed to host/runtime, not model text: typing a custom model
    // must not re-run a CLI discovery process on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canDiscoverModels, engine, selectedComputer?.id, localRuntimeStatus?.computerId])

  const changeEngine = (next: EngineId): void => {
    if (next !== engine) {
      setModel('')
      setFastModel('')
      setReasoningEffort('')
      setThinkingLevel('')
      setRuntimeModels([])
      setRuntimeModelsErr(null)
      setRuntimeOptionsErr(null)
      setCustomModelMode(false)
      setCustomFastModelMode(false)
    }
    setEngine(next)
  }

  const changeComputer = (id: string): void => {
    setComputerId(id)
    const c = computersById[id]
    if (!c || c.kind === 'cloud') {
      changeEngine('managed')
      return
    }
    const next = (agent?.engine as EngineId) && c.availableEngines.includes(agent!.engine as EngineId)
      ? (agent!.engine as EngineId)
      : (c.availableEngines[0] ?? 'claude')
    changeEngine(next)
  }

  const connectThisComputer = async (): Promise<void> => {
    if (!localRuntimeBridge) return
    setLocalRuntimeBusy(true)
    setLocalRuntimeErr(null)
    try {
      const status = await localRuntimeBridge.status()
      setLocalRuntimeStatus(status)
      if (!status.bundled) throw new Error('Local runtime host is missing from this Cumora Desktop build.')
      if (status.engines.length === 0) throw new Error('No supported local runtime was detected. Install and sign in to Claude Code, Codex, or Pi, then try again.')
      const pair = await api.requestPairingCode()
      const serverUrl = origin || ((location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? 'http://localhost:5181' : null)
      const result = await localRuntimeBridge.connect({ pairCode: pair.code, serverUrl })
      if (!result.ok) throw new Error(result.error)
      for (let i = 0; i < 24; i++) {
        await useComputers.getState().refresh()
        const c = useComputers.getState().byId[result.computerId]
        if (c) {
          setComputerId(c.id)
          const next = (c.availableEngines[0] ?? result.engines[0] ?? 'claude') as EngineId
          changeEngine(next)
          setLocalRuntimeStatus(await localRuntimeBridge.status())
          return
        }
        await new Promise((resolve) => window.setTimeout(resolve, 250))
      }
      throw new Error('This computer paired successfully, but it has not appeared in the workspace yet. Re-open the agent editor to retry.')
    } catch (e) {
      setLocalRuntimeErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLocalRuntimeBusy(false)
    }
  }

  const restartThisComputer = async (): Promise<void> => {
    if (!localRuntimeBridge || !selectedComputer) return
    setLocalRuntimeBusy(true)
    setLocalRuntimeErr(null)
    try {
      const repair = repairCode ? { code: repairCode } : await api.repairComputer(selectedComputer.id)
      const serverUrl = origin || ((location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? 'http://localhost:5181' : null)
      const result = await localRuntimeBridge.connect({ pairCode: repair.code, serverUrl })
      if (!result.ok) throw new Error(result.error)
      await useComputers.getState().refresh()
      setLocalRuntimeStatus(await localRuntimeBridge.status())
    } catch (e) {
      setLocalRuntimeErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLocalRuntimeBusy(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async () => {
    setErr(null)
    setBusy(true)
    try {
      if (isByoa && runtime.requiresFastModel && !fastModel.trim()) {
        throw new Error(`${runtime.label} requires an explicit fast model for local triage. Choose a cheap/small model before saving.`)
      }
      const target = computerId || cloud?.id
      const targetComputer = target ? computersById[target] : undefined
      const isByoaTarget = !!targetComputer && targetComputer.kind !== 'cloud'
      const resolvedEngine: EngineId = isByoaTarget
        ? (engine === 'managed'
            ? ((targetComputer.availableEngines.includes('claude') ? 'claude' : targetComputer.availableEngines[0]) as EngineId)
            : engine)
        : 'managed'
      // Don't carry a Codex/OpenAI model id onto Claude (and vice versa).
      // That's how a UI set to "Claude Code" still invoked `codex --model gpt-5.6-sol`.
      let resolvedModel = model.trim() || null
      const looksOpenAi = (id: string) => /^(gpt-|o[1-9]|codex)/i.test(id)
      const looksClaude = (id: string) => /^(claude|haiku|sonnet|opus)/i.test(id)
      if (resolvedEngine === 'claude' && resolvedModel && looksOpenAi(resolvedModel)) resolvedModel = null
      if (resolvedEngine === 'codex' && resolvedModel && looksClaude(resolvedModel)) resolvedModel = null
      const payload: AgentInput = {
        name, role, systemPrompt, bio, avatarBg,
        model: resolvedModel,
        fastModel: fastModel.trim() || null,
      }
      let agentId = agent?.id
      if (editing) {
        if ((agent!.avatarUrl ?? null) !== avatarUrl) payload.avatarUrl = avatarUrl
        await api.updateAgent(agent!.id, payload)
      } else {
        const created = await api.createAgent(payload)
        agentId = created.id
      }
      // Always re-assign on save so the visible Engine dropdown is what the
      // daemon actually hosts — previously we skipped when computerId was
      // unchanged and a stale `managed`/`codex` value stayed in the DB.
      if (agentId && target) {
        await api.assignAgentComputer(agentId, target, isByoaTarget ? resolvedEngine : undefined)
      }
      if (agentId) {
        await putAgentRuntimeOptions(agentId, {
          ...(isByoaTarget && engine === 'codex' && reasoningEffort.trim() ? { reasoningEffort: reasoningEffort.trim() } : {}),
          ...(isByoaTarget && engine === 'pi' && thinkingLevel ? { thinkingLevel } : {}),
        })
      }
      await useParticipants.getState().load()
      await useConversations.getState().reload()
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const initial = (name || agent?.id || '?').charAt(0).toUpperCase()

  const generateAvatar = async () => {
    if (!editing || !agent) return
    setAvatarErr(null)
    setGeneratingAvatar(true)
    try {
      await api.updateAgent(agent.id, { name, role, systemPrompt, bio, avatarBg })
      const r = await api.generateAgentAvatar(agent.id)
      setAvatarUrl(r.url)
      await useParticipants.getState().load()
    } catch (e) {
      setAvatarErr(e instanceof Error ? e.message : String(e))
    } finally {
      setGeneratingAvatar(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-6"
      style={{ background: 'rgba(15, 30, 50, 0.55)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        className="bg-cloud rounded-[18px] shadow-pop w-full max-w-[560px] max-h-[90vh] flex flex-col overflow-hidden"
        style={{ border: '1px solid var(--ink-100)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-ink-100 flex items-center gap-3 shrink-0">
          <div
            className="w-12 h-12 rounded-full grid place-items-center text-white font-bold text-[18px] shrink-0 overflow-hidden relative"
            style={{ background: avatarUrl ? 'transparent' : avatarBg }}
          >
            {avatarUrl
              ? <img src={avatarUrl} alt={name || initial} className="absolute inset-0 w-full h-full object-cover" />
              : initial}
          </div>
          <div className="flex-1">
            <h2 className="font-display font-medium text-[20px] tracking-tight">
              {editing ? `Edit ${agent!.name}` : 'New agent'}
            </h2>
            <div className="text-[12.5px] text-ink-500 italic font-display">
              {editing ? 'Tweak how this teammate behaves.' : 'Define a new teammate from scratch.'}
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full grid place-items-center text-ink-500 hover:bg-sky2-50 hover:text-ink-900 transition"
            aria-label="Close"
          >×</button>
        </div>

        <div className="px-6 py-5 space-y-4 overflow-y-auto flex-1 min-h-0">
          <Field label="Name" hint="What teammates call them. The handle (@-mention id) is derived from this automatically.">
            <Input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Saga" />
          </Field>

          <Field label="Role" hint="One- or two-word title shown next to the name.">
            <Input type="text" value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Storyteller" />
          </Field>

          <Field label="Style (system prompt)" hint="The agent's voice, instincts, and quirks. Written in second person — the LLM reads this as 'you'.">
            <TextArea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={5}
              placeholder="You write narratives. You sense what the team forgets to say out loud. Direct, warm, never preachy."
              className="font-display italic"
              style={{ minHeight: 110 }}
            />
          </Field>

          <Field label="Bio" hint="Optional, shown on the agent card.">
            <TextArea value={bio} onChange={(e) => setBio(e.target.value)} rows={2} placeholder="A one-line description of what they're best at." />
          </Field>

          <div className="rounded-[14px] p-4 space-y-4" style={{ background: 'var(--sky-50)', border: '1px solid var(--sky-100)' }}>
            <div>
              <div className="text-[11px] font-bold tracking-wider uppercase text-ink-500">Runtime</div>
              <div className="text-[11.5px] text-ink-400 mt-0.5 font-display italic">
                Choose where this agent runs, then choose its engine, models, and runtime-specific reasoning behavior.
              </div>
            </div>

            <Field label="Runs on" hint="Which computer executes this agent. Cumora Cloud is managed; a paired computer runs local runtimes using that machine's existing logins.">
              <Select
                ariaLabel="Runs on"
                value={computerId}
                onValueChange={changeComputer}
                options={[
                  ...computers
                    .filter((c) => !(isFreeTier && c.kind === 'cloud'))
                    .map((c) => ({
                      value: c.id,
                      label: `${c.kind === 'cloud' ? '☁' : c.kind === 'vps' ? '🖥' : '💻'} ${c.name}`
                        + (c.kind !== 'cloud' && c.status !== 'online' ? ' (offline)' : ''),
                    })),
                  ...(isFreeTier && !isNativePlatform()
                    ? [{ value: '__cloud_pro__', label: '☁ Cumora Cloud — upgrade to Pro', disabled: true }]
                    : []),
                ]}
              />
            </Field>

            {localRuntimeBridge && localRuntimeStatus && !localComputerVisible && (
              <div className="rounded-[12px] p-3 bg-cloud" style={{ border: '1px solid var(--sky-100)' }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[12px] font-semibold text-ink-900">💻 This computer</div>
                    <div className="text-[11.5px] text-ink-400 mt-0.5 font-display italic">
                      Connect Cumora Desktop directly — no terminal or npx command required.
                    </div>
                    {localRuntimeStatus.engines.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {localRuntimeStatus.engines.map((en) => (
                          <span key={en} className="text-[10.5px] px-2 py-0.5 rounded-full bg-sky2-50 text-ink-600" style={{ border: '1px solid var(--sky-100)' }}>
                            {runtimeLabel(en)} detected
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[11px] text-coral-deep mt-2">No Claude Code, Codex, or Pi runtime was detected on this computer.</div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => { void connectThisComputer() }}
                    disabled={localRuntimeBusy || !localRuntimeStatus.bundled || localRuntimeStatus.engines.length === 0}
                    className="shrink-0 px-3 py-2 rounded-[9px] text-[11.5px] font-semibold text-white bg-skype disabled:opacity-50 transition"
                  >
                    {localRuntimeBusy ? 'Connecting…' : (localRuntimeStatus.paired ? 'Reconnect' : 'Connect')}
                  </button>
                </div>
                {localRuntimeErr && <div className="text-[11px] text-coral-deep mt-2">{localRuntimeErr}</div>}
              </div>
            )}

            {selectedComputer && selectedComputer.kind !== 'cloud' && (
              <Field label="Engine" hint="Only runtimes detected by this computer are offered here.">
                <Select
                  ariaLabel="Engine"
                  value={engine}
                  onValueChange={(v) => changeEngine(v as EngineId)}
                  options={(selectedComputer.availableEngines.length ? selectedComputer.availableEngines : (['claude'] as EngineId[]))
                    .map((en) => ({ value: en, label: runtimeLabel(en) }))}
                />
                <div className="text-[11.5px] text-ink-400 mt-1.5 font-display italic">{runtime.description}</div>
              </Field>
            )}

            <Field label={isByoa ? 'Main model' : 'Model'} hint={runtime.modelHint}>
              <RuntimeModelPicker
                value={model}
                onChange={setModel}
                models={runtimeModels}
                busy={runtimeModelsBusy}
                error={runtimeModelsErr}
                customMode={customModelMode}
                onCustomModeChange={setCustomModelMode}
                allowDefault
                discoveryEnabled={canDiscoverModels}
                onRefresh={() => { void loadRuntimeModels() }}
              />
            </Field>

            {isByoa && runtime.supportsFastModel && (
              <Field label={runtime.requiresFastModel ? 'Fast model · required' : 'Fast model'} hint={runtime.fastModelHint}>
                <RuntimeModelPicker
                  value={fastModel}
                  onChange={setFastModel}
                  models={runtimeModels}
                  busy={runtimeModelsBusy}
                  error={runtimeModelsErr}
                  customMode={customFastModelMode}
                  onCustomModeChange={setCustomFastModelMode}
                  allowDefault={!runtime.requiresFastModel}
                  discoveryEnabled={canDiscoverModels}
                  onRefresh={() => { void loadRuntimeModels() }}
                  placeholder={runtime.requiresFastModel ? 'Choose a cheap/small model' : 'Runtime default'}
                />
              </Field>
            )}

            {isByoa && engine === 'codex' && (
              <Field
                label="Reasoning effort"
                hint={selectedMainModel?.defaultReasoningEffort
                  ? `Model default: ${selectedMainModel.defaultReasoningEffort}. Leave Runtime default to follow the model.`
                  : 'Per-agent Codex reasoning effort. Leave blank to follow the selected model/runtime default.'}
              >
                {codexEfforts.length > 0 ? (
                  <Select
                    ariaLabel="Codex reasoning effort"
                    value={reasoningEffort}
                    onValueChange={setReasoningEffort}
                    options={[
                      { value: '', label: selectedMainModel?.defaultReasoningEffort ? `Runtime default · ${selectedMainModel.defaultReasoningEffort}` : 'Runtime default' },
                      ...codexEfforts.map((effort) => ({ value: effort, label: effort })),
                      ...(reasoningEffort && !codexEfforts.includes(reasoningEffort) ? [{ value: reasoningEffort, label: `${reasoningEffort} · custom` }] : []),
                    ]}
                  />
                ) : (
                  <Input
                    type="text"
                    value={reasoningEffort}
                    onChange={(e) => setReasoningEffort(e.target.value)}
                    placeholder="Runtime default"
                    className="font-mono"
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                )}
              </Field>
            )}

            {isByoa && engine === 'pi' && (
              <Field
                label="Thinking level"
                hint={selectedMainModel?.supportsThinking === false
                  ? 'This Pi model catalog reports no thinking support; Runtime default is recommended.'
                  : 'Controls Pi main-brain reasoning only. The cheap triage brain always runs with thinking off.'}
              >
                <Select
                  ariaLabel="Pi thinking level"
                  value={thinkingLevel}
                  onValueChange={(value) => setThinkingLevel(value as PiThinkingLevel | '')}
                  options={[
                    { value: '', label: 'Runtime default' },
                    ...PI_THINKING_LEVELS.map((level) => ({ value: level, label: level })),
                  ]}
                />
              </Field>
            )}

            {runtimeOptionsBusy && <div className="text-[10.5px] text-ink-400">Loading saved Runtime Options…</div>}
            {runtimeOptionsErr && <div className="text-[11px] text-coral-deep">Runtime Options: {runtimeOptionsErr}</div>}

            {selectedComputerOffline && (
              <div className="rounded-[12px] p-3" style={{ background: 'var(--cloud)', border: '1px solid var(--sky-100)' }}>
                <div className="text-[12px] font-semibold text-ink-900 mb-1">{selectedComputer?.name} is offline.</div>
                {localRuntimeBridge && localRuntimeStatus?.computerId === selectedComputer.id ? (
                  <>
                    <div className="text-[11.5px] text-ink-400 mb-2">Reconnect this desktop-managed runtime without opening a terminal.</div>
                    <button
                      type="button"
                      onClick={() => { void restartThisComputer() }}
                      disabled={localRuntimeBusy || !!repairErr}
                      className="inline-flex items-center justify-center min-w-[120px] text-[11.5px] font-semibold px-3 py-1.5 rounded-[9px] text-white bg-skype disabled:opacity-50 transition"
                    >
                      {localRuntimeBusy ? 'Reconnecting…' : 'Reconnect in app'}
                    </button>
                    {(localRuntimeErr || repairErr) && <div className="text-[11px] text-coral-deep mt-2">{localRuntimeErr || repairErr}</div>}
                  </>
                ) : repairErr ? (
                  <div className="text-[11.5px] text-coral-deep bg-coral-soft rounded-[8px] p-2">{repairErr}</div>
                ) : repairCommand ? (
                  <>
                    <div className="text-[11.5px] text-ink-400 mb-2">This is another computer. Run the reconnect command on that machine:</div>
                    <pre className="bg-ink-900 text-cloud rounded-[9px] p-2.5 text-[11.5px] overflow-x-auto whitespace-pre-wrap break-all font-mono select-all">{repairCommand}</pre>
                    <button
                      type="button"
                      onClick={() => { void navigator.clipboard?.writeText(repairCommand); setRepairCopied(true) }}
                      className="mt-2 inline-flex items-center justify-center min-w-[108px] text-[11.5px] font-semibold px-3 py-1.5 rounded-[9px] text-white transition-colors duration-200"
                      style={{ background: repairCopied ? '#3BB273' : 'var(--skype)' }}
                    >
                      {repairCopied ? '✓ Copied!' : 'Copy command'}
                    </button>
                  </>
                ) : (
                  <div className="text-[11.5px] text-ink-400">Generating reconnect command…</div>
                )}
              </div>
            )}
          </div>

          <Field label="Avatar color" hint="Used as a fallback when no AI portrait is generated.">
            <div className="flex flex-wrap gap-2">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setAvatarBg(c)}
                  className="w-8 h-8 rounded-full transition"
                  style={{
                    background: c,
                    boxShadow: avatarBg === c ? '0 0 0 3px var(--cloud), 0 0 0 5px var(--skype)' : 'inset 0 0 0 1px rgba(0,0,0,0.06)',
                  }}
                  aria-label={c}
                />
              ))}
            </div>
          </Field>

          <Field
            label="AI-generated portrait"
            hint={editing
              ? 'Generates an editorial portrait fitting this agent\'s name, role, and style. Save your edits first if you tweaked the style.'
              : 'Available after the agent is created. Save first, then re-open to generate.'}
          >
            <div className="flex items-center gap-4">
              <div className="relative shrink-0" style={{ width: 88, height: 88 }}>
                {generatingAvatar && (
                  <div
                    className="absolute rounded-full pointer-events-none"
                    style={{
                      inset: -8,
                      background: 'conic-gradient(from 0deg, #FFB088, #7C5CFF, #4FC2F4, #6EC56A, #FFB088)',
                      filter: 'blur(8px)',
                      opacity: 0.55,
                      animation: 'ae-spin 3s linear infinite, ae-breathe 1.6s ease-in-out infinite',
                    }}
                  />
                )}
                <div
                  className="absolute inset-0 rounded-full grid place-items-center text-white font-bold text-[28px]"
                  style={{
                    background: avatarUrl ? 'transparent' : avatarBg,
                    boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.05)',
                    transform: generatingAvatar ? undefined : 'scale(1)',
                    animation: generatingAvatar ? 'ae-pop 1.6s cubic-bezier(.36,1.6,.4,1) infinite' : undefined,
                  }}
                >
                  {avatarUrl
                    ? <img src={avatarUrl} alt={name || initial} className="absolute inset-0 w-full h-full object-cover rounded-full" />
                    : initial}
                  {generatingAvatar && (
                    <div className="absolute inset-0 rounded-full pointer-events-none overflow-hidden">
                      <div
                        className="absolute"
                        style={{
                          inset: '-50%',
                          background: 'linear-gradient(115deg, transparent 35%, rgba(255,255,255,0.55) 50%, transparent 65%)',
                          animation: 'ae-sheen 2.2s cubic-bezier(.4,0,.2,1) infinite',
                        }}
                      />
                    </div>
                  )}
                </div>
                {generatingAvatar && (
                  <>
                    <span className="absolute text-whisper select-none pointer-events-none" style={{ top: -2, right: 6, fontSize: 14, animation: 'ae-twinkle 1.4s ease-in-out infinite', animationDelay: '0s' }}>✦</span>
                    <span className="absolute text-skype-deep select-none pointer-events-none" style={{ bottom: 4, left: -4, fontSize: 11, animation: 'ae-twinkle 1.4s ease-in-out infinite', animationDelay: '0.45s' }}>✦</span>
                    <span className="absolute text-gold select-none pointer-events-none" style={{ top: '40%', left: -6, fontSize: 9, animation: 'ae-twinkle 1.4s ease-in-out infinite', animationDelay: '0.9s' }}>✦</span>
                  </>
                )}
              </div>

              <div className="flex-1 flex flex-col gap-2 min-w-0">
                <button
                  type="button"
                  onClick={generateAvatar}
                  disabled={!editing || generatingAvatar}
                  className="self-start inline-flex items-center gap-1.5 px-3.5 py-2 rounded-[10px] text-[12.5px] font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{
                    background: editing ? 'linear-gradient(135deg, #7C5CFF, #4A2D9E)' : 'var(--ink-100)',
                    color: editing ? 'white' : 'var(--ink-500)',
                    boxShadow: editing && !generatingAvatar ? '0 4px 12px -3px rgba(124, 92, 255, 0.45)' : 'none',
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    style={generatingAvatar ? { animation: 'ae-icon-twinkle 1.2s ease-in-out infinite', transformOrigin: 'center' } : undefined}>
                    <path d="M12 2l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/><path d="M19 14l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/>
                  </svg>
                  {generatingAvatar ? <span>Painting<span className="ae-dots" /></span> : (avatarUrl ? 'Regenerate' : 'Generate with AI')}
                </button>

                {generatingAvatar && (
                  <div className="text-[11.5px] text-whisper-deep font-display italic leading-[1.5]">
                    Composing {name || 'your agent'}'s portrait — usually 15–30s. You can keep editing other fields.
                  </div>
                )}
                {avatarUrl && !generatingAvatar && (
                  <button type="button" onClick={() => setAvatarUrl(null)} className="self-start text-[11.5px] text-ink-500 hover:text-coral-deep transition">
                    clear portrait (use color block instead)
                  </button>
                )}
                {avatarErr && <div className="text-[11.5px] text-coral-deep bg-coral-soft py-1.5 px-2 rounded-md leading-[1.4]">{avatarErr}</div>}
              </div>
            </div>
          </Field>

          {err && <div className="text-[12.5px] text-coral-deep bg-coral-soft py-2 px-3 rounded-lg">{err}</div>}
        </div>

        <div className="px-6 py-4 border-t border-ink-100 flex items-center gap-2 bg-paper shrink-0">
          <button onClick={onClose} className="px-4 py-2 rounded-[9px] text-[12.5px] font-semibold text-ink-700 bg-cloud hover:bg-sky2-50 transition" style={{ border: '1px solid var(--ink-100)' }}>
            Cancel
          </button>
          <div className="flex-1" />
          <button
            onClick={submit}
            disabled={busy || !name.trim() || !systemPrompt.trim() || runtimeOptionsBusy}
            className="px-5 py-2 rounded-[9px] text-[12.5px] font-semibold text-white transition disabled:opacity-50"
            style={{ background: 'var(--skype)', boxShadow: '0 4px 12px -3px rgba(0, 168, 240, 0.5)' }}
          >
            {busy ? 'Saving…' : (editing ? 'Save changes' : 'Create agent')}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes ae-spin   { to { transform: rotate(360deg); } }
        @keyframes ae-breathe { 0%, 100% { opacity: 0.45; transform: scale(1); } 50% { opacity: 0.75; transform: scale(1.08); } }
        @keyframes ae-pop { 0%, 100% { transform: scale(1); } 40% { transform: scale(1.04); } 70% { transform: scale(0.985); } }
        @keyframes ae-sheen { 0% { transform: translateX(-60%) translateY(-60%) rotate(0deg); } 100% { transform: translateX(60%) translateY(60%) rotate(0deg); } }
        @keyframes ae-twinkle { 0%, 100% { opacity: 0.2; transform: scale(0.7); } 50% { opacity: 1; transform: scale(1.15); } }
        @keyframes ae-icon-twinkle { 0%, 100% { opacity: 0.7; transform: scale(0.92); } 50% { opacity: 1; transform: scale(1.08); } }
        @keyframes ae-dot { 0%, 20% { opacity: 0; } 50% { opacity: 1; } 80%, 100% { opacity: 0; } }
        .ae-dots::after { content: '...'; letter-spacing: 2px; display: inline-block; margin-left: 2px; animation: ae-dot 1.4s steps(4, end) infinite; }
      `}</style>
    </div>
  )
}

function RuntimeModelPicker({
  value,
  onChange,
  models,
  busy,
  error,
  customMode,
  onCustomModeChange,
  allowDefault,
  discoveryEnabled,
  onRefresh,
  placeholder = 'Runtime default',
}: {
  value: string
  onChange: (value: string) => void
  models: LocalRuntimeModel[]
  busy: boolean
  error: string | null
  customMode: boolean
  onCustomModeChange: (value: boolean) => void
  allowDefault: boolean
  discoveryEnabled: boolean
  onRefresh: () => void
  placeholder?: string
}) {
  const CUSTOM = '__custom_model__'
  const known = models.some((m) => m.id === value)
  const useCatalog = models.length > 0
  const choice = customMode || (!!value && !known) ? CUSTOM : value
  const defaultModel = models.find((m) => m.isDefault)

  if (!useCatalog) {
    return (
      <div>
        <Input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="font-mono"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
        />
        {discoveryEnabled && (
          <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-ink-400">
            <span>{busy ? 'Reading models from this computer…' : error ? `Model discovery failed: ${error}` : 'No model catalog returned.'}</span>
            {!busy && <button type="button" onClick={onRefresh} className="text-skype-deep hover:underline">retry</button>}
          </div>
        )}
      </div>
    )
  }

  const options = [
    ...(allowDefault ? [{ value: '', label: defaultModel ? `Runtime default · ${defaultModel.label}` : 'Runtime default' }] : []),
    ...models.map((m) => ({
      value: m.id,
      label: m.label === m.id ? m.id : `${m.label} · ${m.id}`,
      hint: m.isDefault ? 'default' : (m.defaultReasoningEffort ?? undefined),
    })),
    { value: CUSTOM, label: 'Custom model…' },
  ]

  return (
    <div>
      <Combobox
        value={choice}
        options={options}
        onValueChange={(next) => {
          if (next === CUSTOM) {
            onCustomModeChange(true)
            onChange('')
          } else {
            onCustomModeChange(false)
            onChange(next)
          }
        }}
        placeholder={placeholder}
        searchPlaceholder="Search local models…"
        ariaLabel="Runtime model"
        emptyText="No matching models"
      />
      {choice === CUSTOM && (
        <Input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="provider/model or model id"
          className="font-mono mt-2"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          autoFocus
        />
      )}
      <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-ink-400">
        <span>{busy ? 'Refreshing local catalog…' : `Loaded ${models.length} model${models.length === 1 ? '' : 's'} from this computer.`}</span>
        {!busy && <button type="button" onClick={onRefresh} className="text-skype-deep hover:underline">refresh</button>}
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-bold tracking-wider uppercase text-ink-500 mb-1">{label}</label>
      {hint && <div className="text-[11.5px] text-ink-300 mb-1.5 font-display italic">{hint}</div>}
      {children}
    </div>
  )
}
