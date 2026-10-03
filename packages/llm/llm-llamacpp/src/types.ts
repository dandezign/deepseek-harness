/**
 * Wire shapes of a llama.cpp server: the OpenAI-compatible chat-completions
 * surface plus the multi-model router's own control surface (`/props`,
 * status-bearing `/v1/models`, `/models/load`, `/models/unload`, `/models/sse`).
 *
 * The chat wire itself (messages, tools, SSE chunks, usage) is shared with
 * `dsh-llm-deepseek`; this module owns only what is llama.cpp-specific.
 *
 * @module dsh-llm-llamacpp/types
 */

/** `GET /props` — server mode and router settings. */
export interface PropsReply {
  /** `router` for a multi-model server, `server` for a single-model one. */
  role?: unknown
  /** Whether the router loads a requested-but-unloaded model on demand. */
  models_autoload?: unknown
  /** Concurrent resident model instances the router allows. */
  max_instances?: unknown
  /** Build identifier, e.g. `b10443-27df9199d` — Strata names itself here. */
  build_info?: unknown
  /** The single model a Strata server serves, resident or not. */
  model_alias?: unknown
  /** Default context capacity (Strata: `default_generation_settings.n_ctx`). */
  default_generation_settings?: { n_ctx?: unknown }
  /** Whether the served model is currently non-resident (Strata). */
  is_sleeping?: unknown
  /** Capability flags (Strata: `{ vision: boolean }`). */
  modalities?: { vision?: unknown }
}

/** Progress attached to a `loading` status-change event. */
export interface LoadProgress {
  /** Stage names the load moves through (`text_model`, …). */
  stages?: unknown
  /** Current stage name. */
  current?: unknown
  /** 0..1 fraction through the current stage. */
  value?: unknown
}

/**
 * `GET /v1/models` entry on a router build. A plain single-model server
 * reports a bare `{ id }` list; every extra field here is optional because
 * older builds omit them.
 */
export interface RouterModelEntry {
  /** Model id, exactly what `/v1/chat/completions` accepts as `model`. */
  id: string
  /** Live status block; absent on single-model servers. */
  status?: {
    /** `unloaded` | `loading` | `loaded` | `unloading`. */
    value?: unknown
    /** Launch argv, when the entry came from a models directory. */
    args?: unknown
  }
  /** Capacity block (Strata answers it even while the model is unloaded). */
  meta?: {
    n_ctx?: unknown
  }
  /** Architecture block carrying input/output modalities. */
  architecture?: {
    /** Input modality names (`text`, `image`). */
    input_modalities?: unknown
    /** Output modality names (`text`). */
    output_modalities?: unknown
  }
}

/** `GET /v1/models` reply. */
export interface ModelsReply {
  data?: RouterModelEntry[]
}

/** One `data:` payload of `GET /models/sse`. */
export interface ModelEvent {
  /** Model id the event concerns. */
  model?: unknown
  /** `model_status` | `status_change`. */
  event?: unknown
  /** Event body: status and progress or loaded-model info. */
  data?: {
    status?: unknown
    progress?: LoadProgress
    /** Present on `unloaded` after a crash or eviction. */
    exit_code?: unknown
    /** Present on `loaded`: the full model entry incl. `meta` capacities. */
    info?: RouterModelEntry & {
      meta?: {
        n_ctx?: unknown
        n_ctx_train?: unknown
        n_params?: unknown
        size?: unknown
      }
    }
  }
}

/** Body of `POST /models/load` and `POST /models/unload`. */
/** Body of `POST /models/load` and `POST /models/unload` (Strata sends an empty body). */
export interface ModelActionBody {
  model?: string
}

/** Reply of `POST /models/load` and `POST /models/unload`. */
export interface ModelActionReply {
  success?: unknown
}
