// Deterministic stand-in for scripts/scrapling_tools.py. Receives the same
// argv the runtime gives the real tool: [fixture, toolScriptPath, jsonRequest].
// DSH_FIXTURE_BEHAVIOR selects the outcome; DSH_FIXTURE_CAPTURE appends each
// received request JSON for assertions; DSH_FIXTURE_STATE carries a counter
// for the *-once behaviors.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const behavior = process.env.DSH_FIXTURE_BEHAVIOR ?? 'ok'
const request = process.argv[3] ?? '{}'

if (process.env.DSH_FIXTURE_CAPTURE !== undefined) {
  appendFileSync(process.env.DSH_FIXTURE_CAPTURE, `${request}\n`)
}

const once = (name) => {
  const statePath = process.env.DSH_FIXTURE_STATE
  const seen = statePath !== undefined && existsSync(statePath) && readFileSync(statePath, 'utf8').trim() === name
  if (statePath !== undefined) writeFileSync(statePath, name)
  return seen
}

const parsed = JSON.parse(request)
const emit = (outcome) => {
  process.stdout.write(`${JSON.stringify(outcome)}\n`)
}

const ok = () => {
  if (parsed.op === 'search') {
    emit({ results: [{ title: 'A', url: 'https://a.test', snippet: 'about a' }, { title: '', url: '', snippet: '' }], count: 2 })
  } else {
    emit({ url: parsed.url, status: 200, content: 'extracted text', truncated: false })
  }
}

switch (behavior) {
  case 'ok':
    ok()
    break
  case 'domain-error':
    emit({ error: 'the site refused the request' })
    break
  case 'env-flag':
    emit({ error: 'scrapling is missing', environment: true })
    break
  case 'env-once':
    if (once('env')) ok()
    else emit({ error: 'scrapling is missing', environment: true })
    break
  case 'exit3-once':
    if (once('exit3')) ok()
    else {
      process.stderr.write('ModuleNotFoundError: no module named scrapling')
      process.exit(3)
    }
    break
  case 'exit1':
    process.stderr.write('catastrophic interpreter failure')
    process.exit(1)
    break
  case 'badjson':
    process.stdout.write('this is not json')
    break
  case 'sleep':
    setTimeout(ok, 30_000)
    break
  case 'huge':
    process.stdout.write(`${'x'.repeat(64 * 1024 * 1024 + 1)}\n`)
    break
  default:
    process.stderr.write(`unknown fixture behavior: ${behavior}`)
    process.exit(1)
}
