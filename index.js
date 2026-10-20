/**
 * Host half of dsh-wind-finance.
 *
 * Registers one agent tool, `wind_finance`, plus a short system-prompt section.
 * The tool routes a financial question to the right Wind data domain, executes it
 * through the Wind meta-router (or the per-domain CLI in batch mode), and returns
 * only what Wind returned.
 *
 * Two rules travel with the tool because they are the ones that get broken in
 * practice: one dataset is pulled once per day, and the interactive channel is not
 * the batch channel. Both channels share a single API key and a single daily quota.
 *
 * @module dsh-wind-finance
 */
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { runWindFinance } from './runner.js'

/** Cordis plugin name. */
export const name = 'dsh-wind-finance'

/** Required host services: tool registry + prompt assembly. */
export const inject = ['tools', 'systemPrompt']

const HERE = dirname(fileURLToPath(import.meta.url))

/* ------------------------------------------------------------------ */
/* defineTool (structure-compatible reimplementation of the SDK's)     */
/* ------------------------------------------------------------------ */

function compileValue(spec) {
  const node = {}
  if (typeof spec.description === 'string' && spec.description.length > 0) node.description = spec.description
  const type = spec.type
  if (type === undefined || type === 'json') return node
  if (type === 'object') {
    node.type = 'object'
    node.additionalProperties = spec.additionalProperties
    if (spec.properties !== undefined) node.properties = compilePropertyMap(spec.properties).properties
    return node
  }
  if (type === 'array') {
    node.type = 'array'
    if (spec.items !== undefined) node.items = compileValue(spec.items)
    return node
  }
  node.type = type
  if (spec.enum !== undefined) node.enum = [...spec.enum]
  if (spec.const !== undefined) node.const = spec.const
  return node
}

function compilePropertyMap(spec) {
  const properties = {}
  const required = []
  for (const [key, entry] of Object.entries(spec)) {
    const { required: isRequired, ...valueSpec } = entry
    properties[key] = compileValue(valueSpec)
    if (isRequired === true) required.push(key)
  }
  return required.length > 0 ? { properties, required } : { properties }
}

function matchesScalarType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

function validateValue(schema, value, path) {
  if (typeof schema.type !== 'string' || schema.type.length === 0) return []
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path} must be an object`]
    const violations = []
    for (const key of schema.required ?? []) if (!(key in value)) violations.push(`${path}.${key} is required`)
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(value)) if (!known.has(key)) violations.push(`${path}.${key} is not a declared property`)
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) violations.push(...validateValue(child, value[key], `${path}.${key}`))
    }
    return violations
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`]
    const violations = []
    value.forEach((item, i) => violations.push(...validateValue(schema.items, item, `${path}[${i}]`)))
    return violations
  }
  if (!matchesScalarType(value, schema.type)) return [`${path} must be ${schema.type}`]
  if (schema.enum !== undefined && !schema.enum.some((v) => v === value)) return [`${path} must be one of ${schema.enum.map(String).join(', ')}`]
  if (schema.const !== undefined && value !== schema.const) return [`${path} must be ${String(schema.const)}`]
  return []
}

function defineTool(options) {
  const compiled = compilePropertyMap(options.parameters)
  const parameters = { type: 'object', properties: compiled.properties }
  if (compiled.required !== undefined) parameters.required = compiled.required
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: {},
      render(args, value) {
        return options.output.render(args, value)
      },
    },
    async execute(args, exec) {
      const violations = validateValue(parameters, args, 'arguments')
      if (violations.length > 0) throw new Error(`Error: invalid arguments: ${violations.join('; ')}`)
      return options.execute(args, exec)
    },
  }
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function renderWind(_args, value) {
  if (value === null || typeof value !== 'object') return [{ type: 'text', text: String(value) }]
  if (value.ok === false) {
    return [{ type: 'text', text: `wind_finance failed [${value.code ?? 'unknown'}]: ${value.message ?? 'unknown error'}` }]
  }

  const lines = []
  lines.push('# Wind finance')
  lines.push(`channel: ${value.channel ?? 'wind-mcp'} | date: ${value.date ?? ''} | ${value.cached === true ? 'served from today\'s receipt (no quota spent)' : 'live call'}`)

  if (value.stage === 'located') {
    lines.push('', '## Candidate Wind tools')
    const columns = value.columns ?? []
    const nameIndex = columns.indexOf('toolName')
    const descIndex = columns.indexOf('description')
    for (const row of value.candidates ?? []) {
      const toolName = nameIndex >= 0 ? row[nameIndex] : undefined
      const description = descIndex >= 0 ? String(row[descIndex] ?? '') : ''
      lines.push(`- \`${toolName ?? 'unknown'}\`${description.length > 0 ? ` — ${description.slice(0, 160)}` : ''}`)
    }
    lines.push('', 'Call again with `tool_name` and `params` to execute one of these.')
    return [{ type: 'text', text: lines.join('\n') }]
  }

  lines.push('', '```json')
  lines.push(JSON.stringify(value.data ?? null, null, 2).slice(0, 6000))
  lines.push('```')
  lines.push('', '> 数据来源于万得 Wind 金融数据服务。')
  lines.push('> Data sourced from Wind Financial Data Service.')
  return [{ type: 'text', text: lines.join('\n') }]
}

/* ------------------------------------------------------------------ */
/* plugin apply                                                        */
/* ------------------------------------------------------------------ */

const PROMPT_SECTION = `## Wind financial data (wind_finance)

For any question about market data, quotes, K-line, screening, funds, indices, bonds, announcements, financial news, macro indicators or cross-instrument aggregates, call wind_finance. Do not answer a financial fact from web search, a public page, or model memory.

Two steps:
1. Call with \`question\` only. The tool returns the ranked Wind tools for that question.
2. Call again with \`tool_name\` plus \`params\` to execute one of them.

Rules:
1. Use the dedicated tool for quotes, K-line and price metrics. analytics_data is for cross-instrument aggregation only, never a bulk-quote entry point.
2. Units and magnitude come from the response metadata. Never convert a value yourself; if no unit is given, keep the raw value and say the unit is unknown.
3. If the instrument cannot be resolved, ask for the full name or the Wind code. Never guess a code.
4. The tool serves a repeated call from today's receipt. A \`cached\` result is a real Wind result from earlier today, not an estimate — say so. Pass \`force: true\` only when the underlying value must be re-pulled.
5. Batch mode (\`mode: "batch"\`) needs \`server_type\` and \`tool_name\`; use it for scheduled jobs and scripts, not for a conversational lookup.
6. Never fall back to another data source to cover an authentication, quota or runtime failure. Report the failure code.`

export function apply(ctx) {
  const disposers = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'wind_finance',
    description: 'Wind financial data. Locates the right Wind tool for a financial question and runs it against the Wind data service (stocks, funds, indices, bonds, announcements, news, macro indicators, cross-instrument aggregates). Pass question alone to locate a tool, then tool_name plus params to execute it. Serves a repeated call from today\'s receipt instead of spending quota twice. Batch mode runs the per-domain CLI for scheduled jobs.',
    parameters: {
      question: {
        type: 'string',
        description: 'The financial question in natural language. Required when tool_name is not given.',
      },
      tool_name: {
        type: 'string',
        description: 'Exact Wind tool name, for example get_stock_price_indicators, search_funds, get_index_kline, query_economic_indicator_data.',
      },
      params: {
        type: 'json',
        description: 'Arguments for the tool. Use the parameter names from the tool schema returned by the first call.',
      },
      mode: {
        type: 'string',
        enum: ['interactive', 'batch'],
        description: 'interactive (default) uses the Wind meta-router; batch uses the per-domain CLI and requires server_type and tool_name.',
      },
      server_type: {
        type: 'string',
        enum: ['stock_data', 'fund_data', 'index_data', 'bond_data', 'financial_docs', 'economic_data', 'analytics_data'],
        description: 'Batch mode only: the Wind data domain that owns the tool.',
      },
      force: {
        type: 'boolean',
        description: 'Re-pull even when today\'s receipt already holds this call. Default false.',
      },
      date: {
        type: 'string',
        description: 'Receipt date in YYYY-MM-DD. Default: today.',
      },
      topK: {
        type: 'number',
        description: 'Number of candidate tools to return when locating one. Default 5.',
      },
    },
    output: { render: renderWind },
    async execute(args) {
      return runWindFinance({
        question: args.question,
        toolName: args.tool_name,
        params: args.params,
        mode: args.mode,
        serverType: args.server_type,
        force: args.force === true,
        date: args.date,
        topK: args.topK,
      })
    },
  })))

  const disposeSection = ctx.systemPrompt.section({
    name: 'dsh-wind-finance',
    order: 187,
    text: PROMPT_SECTION,
  })
  ctx.effect(() => disposeSection, 'dsh-wind-finance: prompt section')

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'dsh-wind-finance: tools')
}

export { HERE as SKILL_DIR }
