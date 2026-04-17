/**
 * Local LLM Adapter — translates Anthropic Messages API ↔ OpenAI Chat Completions API
 * at the fetch level, so the entire existing Anthropic SDK pipeline stays untouched.
 *
 * Used when CLAUDE_CODE_USE_LOCAL=1 to talk to llama.cpp, Ollama, vLLM, etc.
 */

import { logForDebugging } from '../../utils/debug.js'

// ─── Types ────��──────────────────────────────────────────────────────────────

interface AnthropicMessage {
  role: string
  content: string | AnthropicContentBlock[]
}

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  thinking?: string
  signature?: string
}

interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
  [key: string]: unknown
}

interface AnthropicRequest {
  model: string
  max_tokens: number
  system?: string | Array<{ type: string; text: string; [key: string]: unknown }>
  messages: AnthropicMessage[]
  stream?: boolean
  tools?: AnthropicTool[]
  tool_choice?: unknown
  temperature?: number
  stop_sequences?: string[]
  thinking?: { type: string; budget_tokens?: number }
  [key: string]: unknown
}

interface OpenAIMessage {
  role: string
  content?: string | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

interface OpenAIRequest {
  model: string
  max_tokens: number
  messages: OpenAIMessage[]
  stream: boolean
  tools?: OpenAITool[]
  tool_choice?: unknown
  temperature?: number
  stop?: string[]
  stream_options?: { include_usage: boolean }
}

// ─── Request Translation: Anthropic → OpenAI ────────────────────────────────

function convertSystemPrompt(
  system: AnthropicRequest['system'],
): OpenAIMessage[] {
  if (!system) return []
  if (typeof system === 'string') {
    return [{ role: 'system', content: system }]
  }
  // Array of text blocks — join them
  const text = system
    .map(b => b.text || '')
    .filter(Boolean)
    .join('\n\n')
  return text ? [{ role: 'system', content: text }] : []
}

function convertAnthropicContentToText(
  content: string | AnthropicContentBlock[],
): string {
  if (typeof content === 'string') return content
  return content
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text!)
    .join('')
}

function extractToolCalls(
  content: AnthropicContentBlock[],
): OpenAIToolCall[] | undefined {
  const toolUseBlocks = content.filter(b => b.type === 'tool_use')
  if (toolUseBlocks.length === 0) return undefined
  return toolUseBlocks.map(b => ({
    id: b.id || `toolu_${Math.random().toString(36).slice(2, 14)}`,
    type: 'function' as const,
    function: {
      name: b.name || '',
      arguments: JSON.stringify(b.input || {}),
    },
  }))
}

function convertMessages(messages: AnthropicMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = []

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content })
      } else {
        const text = convertAnthropicContentToText(msg.content)
        const toolCalls = extractToolCalls(msg.content)
        result.push({
          role: 'assistant',
          content: text || null,
          ...(toolCalls && { tool_calls: toolCalls }),
        })
      }
    } else if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content })
      } else {
        // Handle mixed user content: text blocks + tool_result blocks
        const textParts: string[] = []
        const toolResults: OpenAIMessage[] = []

        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text)
          } else if (block.type === 'tool_result') {
            let resultContent = ''
            if (typeof block.content === 'string') {
              resultContent = block.content
            } else if (Array.isArray(block.content)) {
              resultContent = block.content
                .filter(b => b.type === 'text' && b.text)
                .map(b => b.text!)
                .join('')
            }
            toolResults.push({
              role: 'tool',
              tool_call_id: block.tool_use_id || '',
              content: resultContent || '',
            })
          }
        }

        // Tool results come first (they respond to the previous assistant tool_calls)
        result.push(...toolResults)

        // Then any text content as a user message
        if (textParts.length > 0) {
          result.push({ role: 'user', content: textParts.join('\n') })
        }

        // If nothing was added (empty content), add empty user message
        if (toolResults.length === 0 && textParts.length === 0) {
          result.push({ role: 'user', content: '' })
        }
      }
    } else {
      // Pass through other roles
      result.push({
        role: msg.role,
        content:
          typeof msg.content === 'string'
            ? msg.content
            : convertAnthropicContentToText(msg.content),
      })
    }
  }

  return result
}

function convertTools(tools?: AnthropicTool[]): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }))
}

function anthropicToOpenAI(body: AnthropicRequest): OpenAIRequest {
  const systemMessages = convertSystemPrompt(body.system)
  const convertedMessages = convertMessages(body.messages)

  const req: OpenAIRequest = {
    model: body.model,
    max_tokens: body.max_tokens,
    messages: [...systemMessages, ...convertedMessages],
    stream: body.stream ?? false,
    ...(body.temperature !== undefined && { temperature: body.temperature }),
    ...(body.stop_sequences && { stop: body.stop_sequences }),
  }

  const tools = convertTools(body.tools)
  if (tools) {
    req.tools = tools
  }

  if (body.stream) {
    req.stream_options = { include_usage: true }
  }

  return req
}

// ��── Response Translation: OpenAI SSE → Anthropic SSE ───────────────────────

function generateId(): string {
  return 'msg_local_' + Math.random().toString(36).slice(2, 14)
}

function generateToolUseId(): string {
  return 'toolu_local_' + Math.random().toString(36).slice(2, 14)
}

/**
 * Transforms an OpenAI SSE stream into an Anthropic SSE stream.
 */
function createAnthropicSSEStream(
  openaiStream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let buffer = ''
  let contentBlockStarted = false
  let contentBlockIndex = 0
  let inputTokens = 0
  let outputTokens = 0
  let msgId = generateId()
  let headersSent = false
  // Track tool call state
  const activeToolCalls = new Map<
    number,
    { id: string; name: string; arguments: string; blockIndex: number }
  >()
  let pendingTextContent = false

  function sseEvent(eventType: string, data: unknown): string {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
  }

  function emitMessageStart(): string {
    return sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  function emitContentBlockStart(index: number): string {
    return sseEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    })
  }

  function emitToolUseBlockStart(
    index: number,
    id: string,
    name: string,
  ): string {
    return sseEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id, name, input: {} },
    })
  }

  function emitTextDelta(index: number, text: string): string {
    return sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text },
    })
  }

  function emitInputJsonDelta(index: number, partialJson: string): string {
    return sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: partialJson },
    })
  }

  function emitContentBlockStop(index: number): string {
    return sseEvent('content_block_stop', {
      type: 'content_block_stop',
      index,
    })
  }

  function emitMessageDelta(
    stopReason: string,
    outTokens: number,
  ): string {
    return sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outTokens },
    })
  }

  function emitMessageStop(): string {
    return sseEvent('message_stop', { type: 'message_stop' })
  }

  function closeTextBlock(): string {
    if (pendingTextContent) {
      pendingTextContent = false
      return emitContentBlockStop(contentBlockIndex++)
    }
    return ''
  }

  function processOpenAIChunk(line: string): string {
    if (!line.startsWith('data: ')) return ''
    const dataStr = line.slice(6).trim()
    if (dataStr === '[DONE]') {
      // Close any open blocks
      let result = closeTextBlock()

      // Close any open tool call blocks
      for (const [, tc] of activeToolCalls) {
        result += emitContentBlockStop(tc.blockIndex)
      }
      activeToolCalls.clear()

      const stopReason =
        contentBlockIndex > 0 && !pendingTextContent ? 'end_turn' : 'end_turn'
      result += emitMessageDelta(stopReason, outputTokens)
      result += emitMessageStop()
      return result
    }

    let chunk: Record<string, unknown>
    try {
      chunk = JSON.parse(dataStr)
    } catch {
      return ''
    }

    let result = ''

    // Emit message_start on first chunk
    if (!headersSent) {
      headersSent = true
      msgId = (chunk.id as string) || msgId
      result += emitMessageStart()
      result += sseEvent('ping', { type: 'ping' })
    }

    // Extract usage if present
    const usage = chunk.usage as
      | {
          prompt_tokens?: number
          completion_tokens?: number
          total_tokens?: number
        }
      | undefined
    if (usage) {
      if (usage.prompt_tokens) inputTokens = usage.prompt_tokens
      if (usage.completion_tokens) outputTokens = usage.completion_tokens
    }

    const choices = chunk.choices as
      | Array<{
          index?: number
          delta?: {
            content?: string | null
            role?: string
            tool_calls?: Array<{
              index: number
              id?: string
              type?: string
              function?: { name?: string; arguments?: string }
            }>
          }
          finish_reason?: string | null
        }>
      | undefined

    if (!choices || choices.length === 0) return result

    const choice = choices[0]!
    const delta = choice.delta

    if (delta) {
      // Handle text content
      if (delta.content) {
        if (!contentBlockStarted) {
          contentBlockStarted = true
          pendingTextContent = true
          result += emitContentBlockStart(contentBlockIndex)
        }
        result += emitTextDelta(contentBlockIndex, delta.content)
      }

      // Handle tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const tcIndex = tc.index ?? 0
          if (tc.id && tc.function?.name) {
            // New tool call starting — close text block if open
            result += closeTextBlock()

            const toolId = tc.id || generateToolUseId()
            const blockIdx = contentBlockIndex++
            activeToolCalls.set(tcIndex, {
              id: toolId,
              name: tc.function.name,
              arguments: tc.function.arguments || '',
              blockIndex: blockIdx,
            })
            result += emitToolUseBlockStart(blockIdx, toolId, tc.function.name)
            if (tc.function.arguments) {
              result += emitInputJsonDelta(blockIdx, tc.function.arguments)
            }
          } else if (tc.function?.arguments) {
            // Continuation of existing tool call
            const existing = activeToolCalls.get(tcIndex)
            if (existing) {
              existing.arguments += tc.function.arguments
              result += emitInputJsonDelta(
                existing.blockIndex,
                tc.function.arguments,
              )
            }
          }
        }
      }
    }

    // Handle finish_reason
    if (choice.finish_reason) {
      // Close text block
      result += closeTextBlock()

      // Close tool call blocks
      for (const [, tc] of activeToolCalls) {
        result += emitContentBlockStop(tc.blockIndex)
      }
      activeToolCalls.clear()

      const stopReason =
        choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn'
      result += emitMessageDelta(stopReason, outputTokens)
      result += emitMessageStop()
    }

    return result
  }

  const reader = openaiStream.getReader()

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          // If stream ended without [DONE], close gracefully
          if (headersSent) {
            let result = closeTextBlock()
            for (const [, tc] of activeToolCalls) {
              result += emitContentBlockStop(tc.blockIndex)
            }
            activeToolCalls.clear()
            if (result) {
              result += emitMessageDelta('end_turn', outputTokens)
              result += emitMessageStop()
              controller.enqueue(encoder.encode(result))
            }
          }
          controller.close()
          return
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // Keep the last (possibly incomplete) line in buffer
        buffer = lines.pop() || ''

        let output = ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          output += processOpenAIChunk(trimmed)
        }

        if (output) {
          controller.enqueue(encoder.encode(output))
        }
      } catch (err) {
        controller.error(err)
      }
    },
    cancel() {
      reader.cancel()
    },
  })
}

// ─── Non-streaming response translation ─���───────────────────────────────────

interface OpenAINonStreamingResponse {
  id: string
  model: string
  choices: Array<{
    message: {
      role: string
      content?: string | null
      tool_calls?: Array<{
        id: string
        type: string
        function: { name: string; arguments: string }
      }>
    }
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

function openaiToAnthropicResponse(
  openaiResp: OpenAINonStreamingResponse,
): Record<string, unknown> {
  const choice = openaiResp.choices?.[0]
  const content: Array<Record<string, unknown>> = []

  if (choice?.message?.content) {
    content.push({ type: 'text', text: choice.message.content })
  }

  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(tc.function.arguments)
      } catch {
        // leave empty
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      })
    }
  }

  const stopReason =
    choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn'

  return {
    id: openaiResp.id || generateId(),
    type: 'message',
    role: 'assistant',
    content,
    model: openaiResp.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens ?? 0,
      output_tokens: openaiResp.usage?.completion_tokens ?? 0,
    },
  }
}

// ─── Custom Fetch ─────────────��──────────────────────────────────────────────

/**
 * Creates a custom fetch function that translates Anthropic API calls
 * to OpenAI-format calls for local LLM servers (llama.cpp, Ollama, etc.).
 *
 * The Anthropic SDK calls this fetch instead of globalThis.fetch.
 * We intercept /v1/messages calls and redirect to /v1/chat/completions.
 */
export function createLocalLlmFetch(
  localBaseURL: string,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  // Strip trailing slash
  const baseURL = localBaseURL.replace(/\/+$/, '')

  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)

    // Only intercept messages API calls
    if (!url.includes('/messages')) {
      // Pass through non-messages requests (unlikely for local usage)
      return globalThis.fetch(input, init)
    }

    logForDebugging(`[local-llm] Intercepting request to: ${url}`)

    // Parse the Anthropic request body
    let anthropicBody: AnthropicRequest
    try {
      const bodyStr =
        typeof init?.body === 'string'
          ? init.body
          : init?.body
            ? await new Response(init.body).text()
            : '{}'
      anthropicBody = JSON.parse(bodyStr) as AnthropicRequest
    } catch (err) {
      logForDebugging(`[local-llm] Failed to parse request body: ${err}`)
      return new Response(
        JSON.stringify({ error: { message: 'Failed to parse request body' } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }

    // Convert to OpenAI format
    const openaiBody = anthropicToOpenAI(anthropicBody)
    logForDebugging(
      `[local-llm] Sending to ${baseURL}/v1/chat/completions (model: ${openaiBody.model}, stream: ${openaiBody.stream})`,
    )

    // Forward to local LLM
    const targetURL = `${baseURL}/v1/chat/completions`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    // Forward API key if provided
    const authHeader =
      init?.headers instanceof Headers
        ? init.headers.get('x-api-key') || init.headers.get('authorization')
        : undefined
    if (authHeader) {
      headers['Authorization'] = authHeader.startsWith('Bearer ')
        ? authHeader
        : `Bearer ${authHeader}`
    }

    let response: Response
    try {
      response = await globalThis.fetch(targetURL, {
        method: 'POST',
        headers,
        body: JSON.stringify(openaiBody),
        signal: init?.signal,
      })
    } catch (err) {
      logForDebugging(`[local-llm] Fetch to local server failed: ${err}`)
      return new Response(
        JSON.stringify({
          error: {
            message: `Local LLM server unreachable at ${targetURL}: ${err}`,
          },
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      )
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown error')
      logForDebugging(
        `[local-llm] Server returned ${response.status}: ${errText}`,
      )
      return new Response(
        JSON.stringify({
          error: {
            type: 'api_error',
            message: `Local LLM error (${response.status}): ${errText}`,
          },
        }),
        { status: response.status, headers: { 'Content-Type': 'application/json' } },
      )
    }

    // Non-streaming: translate response
    if (!anthropicBody.stream) {
      const openaiResp =
        (await response.json()) as OpenAINonStreamingResponse
      const anthropicResp = openaiToAnthropicResponse(openaiResp)
      return new Response(JSON.stringify(anthropicResp), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'request-id': 'local-' + generateId(),
        },
      })
    }

    // Streaming: translate SSE stream
    if (!response.body) {
      return new Response(
        JSON.stringify({ error: { message: 'No response body from local LLM' } }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const anthropicStream = createAnthropicSSEStream(
      response.body,
      anthropicBody.model,
    )

    return new Response(anthropicStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'request-id': 'local-' + generateId(),
      },
    })
  }
}
