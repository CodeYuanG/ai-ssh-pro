/**
 * One place to slice the model's JSON object out of a noisy completion.
 *
 * The old `indexOf('{') + lastIndexOf('}')` pair broke whenever the text carried a second object
 * or trailing prose after the object: the slice spanned both and `JSON.parse` failed, which used to
 * end an entire run.
 */

/** Strip one leading ``` / ```json fence that wraps the whole string. */
function stripOuterFence(text: string): string {
  const s = text.trim()
  const fence = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/im
  const m = s.match(fence)
  return m ? m[1].trim() : s
}

/**
 * First balanced `{...}` block in `text`, honouring strings and escapes.
 * Returns null when the braces never balance (truncated output).
 */
export function sliceJsonObject(text: string): string | null {
  const s = text
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Best-effort JSON object text from a completion.
 * Keeps the legacy `indexOf`/`lastIndexOf` slice as the last resort so truncated-but-parseable
 * output still has a chance where the balanced scan finds nothing.
 */
export function extractJsonObjectText(raw: string): string {
  const s = stripOuterFence(raw)
  const balanced = sliceJsonObject(s)
  if (balanced) return balanced
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) return s.slice(start, end + 1)
  return s
}
