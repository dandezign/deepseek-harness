// Deterministic stand-in for the Obscura CLI. Receives the same argv the
// runtime gives the real binary: [fixture, ...cliArguments]. The mode (probe
// vs render) is detected from the CLI arguments exactly as the runtime issues
// them. DSH_OBSCURA_FIXTURE_PROBE selects the probe stdout (a batch JSON
// status line, or the behaviors "exit1"/"sleep"); DSH_OBSCURA_FIXTURE_RENDER
// selects the render stdout (literal content, or the same behaviors).

const args = process.argv.slice(2)

const sleepUntilKilled = () => {
  // A pending timer keeps the process alive until the runtime kills it.
  setInterval(() => {}, 1000000)
}

if (args.includes('--file')) {
  // Probe mode: the runtime writes the URL list to stdin; "no-drain" exits
  // immediately WITHOUT reading stdin, exercising the writer's EPIPE path.
  if (process.env.DSH_OBSCURA_FIXTURE_PROBE === 'no-drain') {
    process.exit(1)
  }
  let consumed = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { consumed += chunk })
  process.stdin.on('end', () => {
    const behavior = process.env.DSH_OBSCURA_FIXTURE_PROBE ?? ''
    if (behavior === 'exit1') {
      process.stderr.write('probe broken: raw path blocked')
      process.exit(1)
    }
    if (behavior === 'sleep') {
      sleepUntilKilled()
      return
    }
    process.stdout.write(`${behavior}\n`)
    process.exit(0)
  })
} else {
  const behavior = process.env.DSH_OBSCURA_FIXTURE_RENDER ?? ''
  if (behavior === 'exit1') {
    process.stderr.write('render broke: Failed to navigate to https://a.test: navigation error')
    process.exit(1)
  }
  if (behavior === 'sleep') {
    sleepUntilKilled()
  } else {
    // The real CLI reports the loaded URL on stderr right after navigation.
    process.stderr.write('Fetching https://a.test/...\nPage loaded: https://final.test/full - "T"\n')
    process.stdout.write(behavior)
    process.exit(0)
  }
}
