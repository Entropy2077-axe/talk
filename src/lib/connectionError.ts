function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function requireHttpUrl(value: string, label = '接口地址'): string {
  const text = value.trim().replace(/\/+$/, '')
  if (!text) throw new Error(`请先填写${label}`)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error(`${label}格式不正确，请填写以 http:// 或 https:// 开头的完整地址`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label}格式不正确，只支持 http:// 或 https:// 地址`)
  }
  return text
}

export function requireApiKey(value: string, service = ''): string {
  const key = value.trim()
  const prefix = service ? `${service} ` : ''
  if (!key) throw new Error(`请先填写${prefix}API Key`)
  // HTTP authentication headers only accept byte-sized characters in older
  // Android WebViews. A real API key should not contain whitespace, Chinese
  // punctuation, labels copied from a web page, or other Unicode characters.
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw new Error(`${prefix}API Key 含有空格、中文或特殊字符，请只复制 Key 本身`)
  }
  return key
}

function payloadDetail(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  const nestedError = record.error && typeof record.error === 'object'
    ? (record.error as Record<string, unknown>).message
    : record.error
  const detail = [record.message, nestedError, record.detail]
    .find((value): value is string => typeof value === 'string' && !!value.trim())
  return detail?.trim().slice(0, 180) ?? ''
}

export function parseJsonText(text: string, service: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) throw new Error(`${service}没有返回数据，请检查接口地址是否正确`)
  if (/^\s*</.test(trimmed) || /<!doctype|<html/i.test(trimmed)) {
    throw new Error(`${service}返回了网页而不是接口数据，请检查接口地址是否填写正确`)
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    throw new Error(`${service}返回的数据格式不正确，可能不是兼容的接口`)
  }
}

export function httpFailureMessage(service: string, status: number, payload?: unknown): string {
  const detail = payloadDetail(payload)
  const suffix = detail ? `：${detail}` : ''
  if (status === 401 || status === 403) return `${service}认证失败，请检查 API Key 是否正确或是否有权限${suffix}`
  if (status === 404) return `${service}接口不存在，请检查接口地址是否正确${suffix}`
  if (status === 408 || status === 504) return `${service}连接超时，请稍后重试${suffix}`
  if (status === 429) return `${service}请求过于频繁或额度不足，请稍后重试${suffix}`
  if (status >= 500) return `${service}暂时不可用（HTTP ${status}），请稍后重试${suffix}`
  return `${service}请求失败（HTTP ${status}）${suffix}`
}

export function friendlyConnectionError(error: unknown, service: string): string {
  const message = errorText(error)
  if (/abort|timed?\s*out|timeout/i.test(message)) return `${service}连接超时，请检查网络后重试`
  if (/ISO-8859-1|ByteString|RequestInit.*headers|header.*character/i.test(message)) {
    return `${service} API Key 含有空格、中文或特殊字符，请只复制 Key 本身`
  }
  if (/Unexpected token.*<|doctype|not valid JSON|JSON Parse/i.test(message)) {
    return `${service}返回了网页而不是接口数据，请检查接口地址是否填写正确`
  }
  if (/Failed to fetch|fetch failed|NetworkError|Load failed|ERR_|network request failed/i.test(message)) {
    return `无法连接${service}，请检查网络、接口地址和服务是否已启动`
  }
  if (/Invalid URL|URL.*invalid|could not parse/i.test(message)) {
    return `${service}接口地址格式不正确，请填写以 http:// 或 https:// 开头的完整地址`
  }
  // Messages deliberately produced by our request layer are already written
  // for users. Preserve them, including service names that start in English.
  if (/[\u3400-\u9fff]/.test(message)) return message
  return `${service}连接失败，请检查配置后重试`
}
