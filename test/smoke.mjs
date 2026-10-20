/**
 * Smoke test for dsh-wind-finance.
 *
 * Offline by default: structure, routing table, skill frontmatter and secret
 * hygiene. Set WIND_SMOKE_LIVE=1 to also pull one live quote and assert that a
 * second identical call is served from the day receipt instead of spending quota.
 *
 *   node test/smoke.mjs
 *   WIND_SMOKE_LIVE=1 node test/smoke.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 1. package manifest                                                  */
/* ------------------------------------------------------------------ */

console.log('\n[1] package manifest')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
check('name is dsh-wind-finance', manifest.name === 'dsh-wind-finance', manifest.name)
check('version is semver', /^\d+\.\d+\.\d+$/.test(manifest.version), manifest.version)
check('bundle patch declared', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('no runtime dependencies', manifest.dependencies === undefined)
check('entry point exists', readdirSync(ROOT).includes('index.js'))

const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
check('patch inserts one bundle row', /id:\s*dsh-wind-finance/.test(patch) && /name:\s*dsh-wind-finance/.test(patch))

/* ------------------------------------------------------------------ */
/* 2. routing table                                                     */
/* ------------------------------------------------------------------ */

console.log('\n[2] routing table')
const routing = JSON.parse(readFileSync(join(ROOT, 'core', 'routing.json'), 'utf8'))
const expectedDomains = ['stock_data', 'fund_data', 'index_data', 'bond_data', 'financial_docs', 'economic_data', 'analytics_data']
for (const domain of expectedDomains) {
  const entry = routing.domains?.[domain]
  check(`domain ${domain} declares tools`, Array.isArray(entry?.tools) && entry.tools.length > 0)
}
check('arbitration rules present', Array.isArray(routing.arbitration) && routing.arbitration.length > 0)
check('guardrails present', Array.isArray(routing.guardrails) && routing.guardrails.length > 0)
check('discipline present', Array.isArray(routing.discipline) && routing.discipline.length > 0)
check('completion states present', Array.isArray(routing.completion_states) && routing.completion_states.length > 0)
check('interactive channel is the meta-router', routing.channels?.interactive?.tools?.includes('market_call_tool') === true)

/* ------------------------------------------------------------------ */
/* 3. harness-readable skill                                            */
/* ------------------------------------------------------------------ */

console.log('\n[3] skill text')
const skill = readFileSync(join(ROOT, 'SKILL.md'), 'utf8')
const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)
check('SKILL.md has frontmatter', frontmatter !== null)
check('frontmatter names the skill', /^name:\s*wind-finance$/m.test(frontmatter?.[1] ?? ''))
check('frontmatter has a description', /^description:\s*\S/m.test(frontmatter?.[1] ?? ''))
check('skill documents the tool', /wind_finance/.test(skill))
check('skill lists every domain', expectedDomains.every((domain) => skill.includes(domain)))
check('skill states the source attribution', /数据来源于万得/.test(skill))

/* ------------------------------------------------------------------ */
/* 4. secret hygiene                                                    */
/* ------------------------------------------------------------------ */

console.log('\n[4] secret hygiene')
const files = walk(ROOT).filter((file) => !file.endsWith('.tgz'))
const secretPattern = /(Bearer\s+[A-Za-z0-9]{16,}|ak_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{16,})/
let secretHits = 0
for (const file of files) {
  if (secretPattern.test(readFileSync(file, 'utf8'))) {
    secretHits += 1
    console.log(`       hit: ${file.replace(ROOT, '.')}`)
  }
}
check('no embedded credential in the package', secretHits === 0)

const absolutePathPattern = /\/Users\/[A-Za-z0-9._-]+\//
let pathHits = 0
for (const file of files) {
  if (absolutePathPattern.test(readFileSync(file, 'utf8'))) {
    pathHits += 1
    console.log(`       hit: ${file.replace(ROOT, '.')}`)
  }
}
check('no machine-local absolute path in the package', pathHits === 0)

/* ------------------------------------------------------------------ */
/* 5. live call (opt-in)                                                */
/* ------------------------------------------------------------------ */

if (process.env.WIND_SMOKE_LIVE === '1') {
  console.log('\n[5] live call')
  const { runWindFinance } = await import('../runner.js')
  const first = await runWindFinance({
    question: '贵州茅台最新成交价',
    toolName: 'get_stock_price_indicators',
    params: { windcode: '600519.SH', indexes: '中文简称,最新成交价,涨跌幅' },
    date: '2000-01-01',
  })
  check('live call succeeded', first.ok === true, first.message)
  if (first.ok === true) {
    const rows = first.data?.data?.rows ?? first.data?.rows
    check('live call returned a row', Array.isArray(rows) && rows.length > 0)
    check('row carries the instrument', JSON.stringify(rows ?? []).includes('600519.SH'))
  }

  const second = await runWindFinance({
    question: '贵州茅台最新成交价',
    toolName: 'get_stock_price_indicators',
    params: { windcode: '600519.SH', indexes: '中文简称,最新成交价,涨跌幅' },
    date: '2000-01-01',
  })
  check('second identical call is served from the receipt', second.ok === true && second.cached === true)
} else {
  console.log('\n[5] live call — skipped (set WIND_SMOKE_LIVE=1 to enable)')
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
