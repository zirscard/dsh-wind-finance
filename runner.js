/**
 * Runtime bridge for dsh-wind-finance.
 *
 * Wind exposes one meta-router endpoint (vserver_wind_tools) that dispatches to
 * seven data domains, plus a per-domain CLI used for scheduled jobs. This bridge:
 *
 *   - resolves the API token from the environment, falling back to the host profile
 *     patch. The token is read in place and never logged, copied into the package,
 *     or written to any output file;
 *   - speaks the streamable-http JSON-RPC dialect of the Wind meta-router;
 *   - runs the same call through the Wind CLI in batch mode;
 *   - keeps a per-day receipt, so the same dataset is not pulled twice against the
 *     single daily quota that every channel shares.
 *
 * No npm dependencies.
 *
 * @module dsh-wind-finance/runner
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Wind meta-router endpoint. Overridable for a private deployment. */
export const MCP_ENDPOINT = process.env.WIND_MCP_ENDPOINT ?? 'https://mcp.wind.com.cn/vserver_wind_tools/mcp/'

/** Wind per-domain CLI skill directory (batch mode). */
export const CLI_SKILL_DIR = process.env.WIND_MCP_SKILL_DIR ?? join(homedir(), '.agents', 'skills', 'wind-mcp-skill')

/* ------------------------------------------------------------------ */
/* credential resolution                                                */
/* ------------------------------------------------------------------ */

/** Host home that owns profile configuration and plugin state. */
export function dshHome() {
  const override = process.env.DSH_HOME
  return override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh')
}

/**
 * Resolve the Wind API token.
 *
 * Order: WIND_API_KEY, WIND_MCP_TOKEN, then the host profile patch (read-only).
 * Returns undefined when no credential is available; the caller turns that into a
 * structured BLOCKED_KEY result instead of guessing.
 */
export function resolveToken() {
  for (const name of ['WIND_API_KEY', 'WIND_MCP_TOKEN']) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  try {
    const patch = join(dshHome(), 'profiles', 'desktop', 'cordis.patch.yml')
    if (existsSync(patch)) {
      const text = readFileSync(patch, 'utf8')
      const match = text.match(/id:\s*wind-tools[\s\S]*?Authorization:\s*['"]Bearer\s+([A-Za-z0-9_-]+)['"]/)
      if (match !== null) return match[1]
    }
  } catch {
    /* unreadable profile: fall through to the missing-credential path */
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* meta-router transport                                                */
/* ------------------------------------------------------------------ */

/**
 * Call one JSON-RPC method on the Wind meta-router.
 *
 * The endpoint is stateless: every request carries its own bearer token and no
 * session id. Responses arrive as a single SSE `data:` frame.
 */
export async function mcpRpc(method, params, { timeoutMs = 60000 } = {}) {
  const token = resolveToken()
  if (token === undefined) {
    return { ok: false, code: 'BLOCKED_KEY', message: 'No Wind API token available. Set WIND_API_KEY in the host environment.' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params !== undefined ? { params } : {}) }),
      signal: controller.signal,
    })
    const raw = await response.text()
    if (!response.ok) {
      const code = response.status === 401 ? 'BLOCKED_KEY'
        : response.status === 429 ? 'BLOCKED_QUOTA'
          : 'BLOCKED_RUNTIME'
      return { ok: false, code, message: `Wind endpoint returned HTTP ${response.status}`, status: response.status }
    }
    let payload
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        payload = JSON.parse(line.slice(5).trim())
        break
      }
    }
    if (payload === undefined) payload = JSON.parse(raw)
    if (payload.error !== undefined) {
      return { ok: false, code: payload.error.code ?? 'BLOCKED_RUNTIME', message: payload.error.message ?? 'unknown MCP error' }
    }
    return { ok: true, result: payload.result ?? {} }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return { ok: false, code: 'BLOCKED_RUNTIME', message: aborted ? 'Wind request timed out' : `Wind request failed: ${error?.message ?? error}` }
  } finally {
    clearTimeout(timer)
  }
}

/** Unwrap an MCP tool result into a plain payload. */
export function parseToolResult(result) {
  const text = (result?.content ?? []).map((part) => part?.text ?? '').join('\n')
  if (result?.isError === true) {
    return { ok: false, code: 'BLOCKED_RUNTIME', message: text.slice(0, 800) || 'Wind tool reported an error' }
  }
  try {
    return { ok: true, data: JSON.parse(text) }
  } catch {
    return { ok: true, data: text }
  }
}

/** Locate a Wind tool by natural-language question. */
export async function searchTools(question, topK = 5) {
  const call = await mcpRpc('tools/call', { name: 'market_search_tools', arguments: { question, topK } })
  if (!call.ok) return call
  const parsed = parseToolResult(call.result)
  if (!parsed.ok) return parsed
  return { ok: true, candidates: parsed.data?.rows ?? [], columns: parsed.data?.columnNames ?? [], raw: parsed.data }
}

/** Run one Wind tool by name. */
export async function callTool(toolName, args) {
  const call = await mcpRpc('tools/call', {
    name: 'market_call_tool',
    arguments: { toolName, arguments: args ?? {} },
  })
  if (!call.ok) return call
  return parseToolResult(call.result)
}

/* ------------------------------------------------------------------ */
/* batch channel (per-domain CLI)                                       */
/* ------------------------------------------------------------------ */

/**
 * Run a Wind call through the per-domain CLI. Batch mode only: scheduled jobs and
 * scripts that cannot reach MCP tools.
 */
export function cliCall(serverType, toolName, params) {
  return new Promise((resolve) => {
    const script = join(CLI_SKILL_DIR, 'scripts', 'cli.mjs')
    if (!existsSync(script)) {
      resolve({ ok: false, code: 'BLOCKED_RUNTIME', message: `Wind CLI not found at ${CLI_SKILL_DIR}. Set WIND_MCP_SKILL_DIR.` })
      return
    }
    const child = spawn(process.execPath, [script, 'call', serverType, toolName, JSON.stringify(params ?? {})], {
      cwd: CLI_SKILL_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, code: 'BLOCKED_RUNTIME', message: `Wind CLI failed to start: ${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        resolve({ ok: false, code: 'BLOCKED_RUNTIME', message: `Wind CLI exited with code ${code}: ${stderr.slice(0, 400)}` })
        return
      }
      try {
        const envelope = JSON.parse(stdout)
        if (envelope.isError === true || typeof envelope.code === 'string') {
          resolve({ ok: false, code: envelope.code ?? 'BLOCKED_RUNTIME', message: envelope.message ?? 'Wind CLI error' })
          return
        }
        const inner = (envelope.content ?? []).map((part) => part?.text ?? '').join('\n')
        try {
          resolve({ ok: true, data: JSON.parse(inner) })
        } catch {
          resolve({ ok: true, data: inner })
        }
      } catch (error) {
        resolve({ ok: false, code: 'BLOCKED_RUNTIME', message: `Unreadable Wind CLI output: ${error.message}` })
      }
    })
  })
}

/* ------------------------------------------------------------------ */
/* per-day receipt + response cache                                     */
/* ------------------------------------------------------------------ */

/** Directory holding receipts and cached payloads. */
export function stateDir() {
  return join(dshHome(), 'wind-finance')
}

/** Local calendar date, used as the receipt key. */
export function localDate(date) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function receiptPath(date) {
  return join(stateDir(), 'receipts', `${date}.json`)
}

function cachePath(date, key) {
  return join(stateDir(), 'cache', date, `${key}.json`)
}

/** Stable key for a call: tool name plus a digest of its arguments. */
export function callKey(toolName, args) {
  const digest = createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex').slice(0, 16)
  return `${toolName}-${digest}`
}

/** Read one day of receipts. */
export function readReceipt(date) {
  try {
    return JSON.parse(readFileSync(receiptPath(date), 'utf8'))
  } catch {
    return { date, channel: 'wind', calls: { success: 0, failed: 0, retry: 0 }, steps: [] }
  }
}

/** Find a completed call in the receipt. */
export function findReceiptStep(date, key) {
  return readReceipt(date).steps.find((step) => step.key === key && step.ok === true)
}

/** Read a cached payload for a completed call. */
export function readCache(date, key) {
  try {
    return JSON.parse(readFileSync(cachePath(date, key), 'utf8'))
  } catch {
    return undefined
  }
}

/** Append a step to the day receipt and cache its payload. */
export function writeReceipt(date, step, payload) {
  const receipt = readReceipt(date)
  receipt.date = date
  receipt.steps = receipt.steps.filter((entry) => entry.key !== step.key)
  receipt.steps.push(step)
  if (step.ok === true) receipt.calls.success += 1
  else receipt.calls.failed += 1
  receipt.finished_at = new Date().toISOString()
  mkdirSync(join(stateDir(), 'receipts'), { recursive: true })
  writeFileSync(receiptPath(date), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  if (step.ok === true && payload !== undefined) {
    const target = cachePath(date, step.key)
    mkdirSync(join(stateDir(), 'cache', date), { recursive: true })
    writeFileSync(target, `${JSON.stringify(payload)}\n`, 'utf8')
  }
}

/** List the dates that already have a receipt. */
export function receiptDates() {
  try {
    return readdirSync(join(stateDir(), 'receipts')).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort()
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ */
/* orchestration                                                        */
/* ------------------------------------------------------------------ */

/**
 * Run one financial data call.
 *
 * mode 'interactive' (default): locate the tool by question when `toolName` is
 * absent, then execute it through the meta-router. mode 'batch': execute it
 * through the per-domain CLI, which needs an explicit server type and tool name.
 *
 * When the same call already succeeded today and `force` is not set, the cached
 * payload is returned instead of spending quota again.
 */
export async function runWindFinance(options) {
  const mode = options.mode === 'batch' ? 'batch' : 'interactive'
  const date = localDate(options.date)
  const started = Date.now()

  if (mode === 'batch') {
    if (typeof options.serverType !== 'string' || options.serverType.length === 0) {
      return { ok: false, code: 'USAGE_ERROR', message: 'Batch mode needs server_type (for example stock_data).' }
    }
    if (typeof options.toolName !== 'string' || options.toolName.length === 0) {
      return { ok: false, code: 'USAGE_ERROR', message: 'Batch mode needs tool_name.' }
    }
    const key = callKey(options.toolName, options.params)
    if (options.force !== true) {
      const cached = findReceiptStep(date, key)
      if (cached !== undefined) {
        const payload = readCache(date, key)
        if (payload !== undefined) return { ok: true, channel: 'batch-cli', cached: true, key, date, data: payload }
      }
    }
    const result = await cliCall(options.serverType, options.toolName, options.params)
    const step = {
      key,
      step: options.toolName,
      channel: 'batch-cli',
      ok: result.ok,
      seconds: (Date.now() - started) / 1000,
      at: new Date().toISOString(),
    }
    writeReceipt(date, step, result.ok ? result.data : undefined)
    if (!result.ok) return { ...result, channel: 'batch-cli', key, date }
    return { ok: true, channel: 'batch-cli', cached: false, key, date, data: result.data }
  }

  if (typeof options.toolName === 'string' && options.toolName.length > 0) {
    const key = callKey(options.toolName, options.params)
    if (options.force !== true) {
      const cached = findReceiptStep(date, key)
      if (cached !== undefined) {
        const payload = readCache(date, key)
        if (payload !== undefined) return { ok: true, channel: 'wind-mcp', cached: true, key, date, data: payload }
      }
    }
    const result = await callTool(options.toolName, options.params)
    const step = {
      key,
      step: options.toolName,
      channel: 'wind-mcp',
      ok: result.ok,
      seconds: (Date.now() - started) / 1000,
      at: new Date().toISOString(),
    }
    writeReceipt(date, step, result.ok ? result.data : undefined)
    if (!result.ok) return { ...result, channel: 'wind-mcp', key, date }
    return { ok: true, channel: 'wind-mcp', cached: false, key, date, data: result.data }
  }

  const search = await searchTools(options.question, options.topK ?? 5)
  if (!search.ok) return { ...search, channel: 'wind-mcp', date }
  return {
    ok: true,
    channel: 'wind-mcp',
    stage: 'located',
    date,
    candidates: search.candidates,
    columns: search.columns,
    hint: 'Pick a tool_name from candidates, then call again with tool_name and params.',
  }
}
