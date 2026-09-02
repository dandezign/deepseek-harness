// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import type { ModelLoadProgressState } from '../src/client/slots.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        description: 'Fast catalog description',
        reasoning,
      }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(cleanup)

describe('ModelSelect reasoning effort', () => {
  it('renders effort names without descriptions and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      progress={createSnapshotStore<ModelLoadProgressState>(null)}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'Max'])
    expect(screen.queryByText('Largest budget')).toBeNull()

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 Max')
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      progress={createSnapshotStore<ModelLoadProgressState>(null)}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('shows the durable model id when the catalog has no matching display name', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      progress={createSnapshotStore<ModelLoadProgressState>(null)}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择模型，当前 deepseek-official/removed-model' })
    expect(trigger.textContent).toContain('deepseek-official/removed-model')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.queryByRole('menuitemradio', { name: 'removed-model' })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
    expect(screen.queryByText('Fast catalog description')).toBeNull()
  })

  it('shows loading until the catalog and Session projection are both ready', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: null,
      routable: null,
      groups: [],
      status: 'loading',
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      progress={createSnapshotStore<ModelLoadProgressState>(null)}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    expect(screen.getByRole('button', { name: '正在加载模型…' }).textContent)
      .toContain('正在加载模型…')
    directory.set(state())
    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
      })).toBeTruthy()
    })
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({ groups, status: 'error', error: 'session/model-unavailable: session already contains images' }))
      return false
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      progress={createSnapshotStore<ModelLoadProgressState>(null)}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：session/model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      progress={createSnapshotStore<ModelLoadProgressState>(null)}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe('ModelSelect model-load progress banner', () => {
  it('tracks the live load transitions the host pushes, through settlement', async () => {
    const progress = createSnapshotStore<ModelLoadProgressState>(null)
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state())}
      progress={progress}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    progress.set({ seq: 1, provider: 'llamacpp', model: 'qwen3-8b', phase: 'loading' })
    await screen.findByText(/正在加载模型 qwen3-8b/)

    progress.set({ seq: 2, provider: 'llamacpp', model: 'qwen3-8b', phase: 'ready' })
    await screen.findByText('模型 qwen3-8b 已加载并切换')
  })

  it('announces a failed load with its message', async () => {
    const progress = createSnapshotStore<ModelLoadProgressState>(
      { seq: 1, provider: 'llamacpp', model: 'qwen3-8b', phase: 'failed', message: 'did not become loaded within 600000ms' },
    )
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state())}
      progress={progress}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    const banner = await screen.findByRole('status')
    expect(banner.getAttribute('aria-live')).toBe('assertive')
    expect(banner.textContent).toContain('模型 qwen3-8b 加载失败：did not become loaded within 600000ms')
  })

  it('renders no banner while no load is in flight', () => {
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore(state())}
      progress={createSnapshotStore<ModelLoadProgressState>(null)}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    expect(screen.queryByRole('status')).toBeNull()
  })
})
