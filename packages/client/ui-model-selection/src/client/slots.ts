/**
 * ModelSelect's injected face. The target 'conversation.input.model' seat is
 * declared (children table) and typed by ui-conversation's composer-bar
 * entry; this package only contributes the single occupant, so no SlotMap
 * merge lives here.
 */
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelDirectoryState } from './directory.ts'

/** Live model-load progress the host pushes; null while nothing is in flight. */
export type ModelLoadProgressState = {
  /** Monotonic sequence; the owner clears a terminal state only by its own. */
  seq: number
  /** Provider route id owning the lifecycle (e.g. `llamacpp`). */
  provider: string
  /** Wire model id the transition concerns. */
  model: string
  /** `loading` while the load runs; `ready`/`failed` once it settles. */
  phase: 'loading' | 'ready' | 'failed'
  /** Failure detail on `failed`. */
  message?: string
} | null

/** Injected business face of the composer model seat. */
export interface ModelSelectInjected {
  /** Whether this session supports Agent-bound model inspection and selection. */
  available: boolean
  /** The session's shared directory store (same instance the /model popup reads). */
  directory: SnapshotStore<ModelDirectoryState>
  /**
   * Host-global live model-load progress (one load at a time); the seat turns
   * it into the transient load/switch banner.
   */
  progress: SnapshotStore<ModelLoadProgressState>
  /** Refresh the advisory directory (fire-and-forget; errors land on the store). */
  load: () => void
  /**
   * Select a complete provider/model/reasoning selection.
   * @param selection - model selection and optional adapter-owned effort.
   * @returns whether the host accepted the selection.
   */
  select: (selection: ModelSelection) => Promise<boolean>
}
