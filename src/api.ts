import { readStoredAPIKey } from './lib/studioKey'
import { requireKey } from './lib/requestKey'
import type { ImagePromptTemplate, ImagePromptTemplatePayload } from './types'
import type { CreateImageJobPayload, ImageAsset, ImageGenerationJob, ImageStudioQuota, SiteBranding } from './types'

type StoredJob = ImageGenerationJob & { owner: string }
const pending = new Set<number>()
let dbPromise: Promise<IDBDatabase> | undefined
function database() {
  return dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('image-studio-workbench', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('jobs', { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(new Error('无法打开本地作品存储，请允许浏览器使用站点存储。'))
  })
}
async function storage<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('jobs', mode)
    const req = run(tx.objectStore('jobs'))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = () => reject(tx.error || new Error('作品存储失败'))
    tx.onabort = () => reject(tx.error || new Error('作品存储已中止'))
  })
}
async function owner(key: string) {
  // No raw keys in history records. crypto.subtle requires HTTPS/localhost.
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
}
async function jobs(key: string) {
  const hash = await owner(key)
  const all = await storage<StoredJob[]>('readonly', store => store.getAll())
  return all.filter(job => job.owner === hash).sort((a, b) => b.id - a.id)
}
async function jobById(key: string, id: number) {
  const job = (await jobs(key)).find(job => job.id === id)
  if (!job) throw new Error('未找到此任务')
  if (['running', 'queued'].includes(job.status) && !pending.has(job.id)) {
    job.status = 'failed'; job.error_message = '页面关闭或刷新中断了任务，请重新生成。'
    await storage('readwrite', store => store.put(job))
  }
  return job
}
function paginate<T>(items: T[], params: { page?: number; pageSize?: number }) {
  const size = params.pageSize || 20
  return items.slice(((params.page || 1) - 1) * size, (params.page || 1) * size)
}
async function responseJSON(response: Response) {
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error?.message || body?.message || `请求失败 (${response.status})`)
  if (!body) throw new Error('接口返回了无效 JSON')
  return body
}
async function create(key: string, payload: CreateImageJobPayload, edit: boolean) {
  const job: StoredJob = {
    id: Date.now() * 1000 + Math.floor(Math.random() * 1000), owner: await owner(key), status: 'running',
    prompt: payload.prompt, params_json: JSON.stringify(payload), api_key_id: 0,
    api_key_name: '', api_key_masked: '', error_message: '', duration_ms: 0,
    created_at: new Date().toISOString(), started_at: new Date().toISOString(), assets: [],
  }
  // Retain image references in IndexedDB so the original retry/edit flow can restore them.
  job.params_json = JSON.stringify(payload)
  await storage('readwrite', store => store.put(job))
  pending.add(job.id)
  void (async () => {
    const started = Date.now()
    try {
      const prompt = [payload.prompt, payload.style].filter(Boolean).join('\n\n')
      let body: BodyInit; const headers: Record<string, string> = { Authorization: `Bearer ${key}` }
      const params = { model: payload.model, prompt, size: payload.size, quality: payload.quality, output_format: payload.output_format, background: payload.background, upscale: payload.upscale, strict_size: payload.strict_size, upscale_fit: payload.upscale_fit, n: 1 }
      if (edit) {
        const form = new FormData()
        for (const [name, value] of Object.entries(params)) if (value !== undefined) form.append(name, String(value))
        for (const [index, image] of (payload.input_images || []).entries()) {
          const blob = await (await fetch(image)).blob()
          const extension = blob.type.split('/')[1] || 'png'
          form.append('image[]', blob, `reference-${index}.${extension}`)
        }
        body = form
      } else { headers['Content-Type'] = 'application/json'; body = JSON.stringify(params) }
      const result = await responseJSON(await fetch(`/api/images/${edit ? 'edits' : 'generations'}`, {
        method: 'POST', headers, body, signal: AbortSignal.timeout(600_000),
      }))
      if (!Array.isArray(result.data) || !result.data.length) throw new Error('接口未返回图片')
      const assets: ImageAsset[] = result.data.map((item: { b64_json?: string; url?: string; revised_prompt?: string }, index: number) => {
        if (!item.b64_json && !item.url) throw new Error('图片响应缺少 url 或 b64_json')
        if (item.url && !/^https?:\/\//i.test(item.url)) throw new Error('图片 URL 协议不受支持')
        const format = payload.output_format || 'png'
        const size = payload.size?.split('x').map(Number) || [0, 0]
        return { id: job.id + index, job_id: job.id, template_id: 0, filename: `image-${job.id}-${index}.${format}`,
          mime_type: `image/${format}`, bytes: 0, width: size[0], height: size[1], model: payload.model || 'gpt-image-2',
          requested_size: payload.size || 'auto', actual_size: payload.size || 'auto', quality: payload.quality || 'auto',
          output_format: format, revised_prompt: item.revised_prompt || payload.prompt, created_at: new Date().toISOString(),
          ...(item.b64_json ? { cache_b64_json: item.b64_json } : { proxy_url: item.url }),
        }
      })
      job.assets = assets; job.status = 'succeeded'
    } catch (error) {
      job.status = 'failed'; job.error_message = error instanceof Error ? error.message : '生成失败'
    } finally {
      job.duration_ms = Date.now() - started; job.completed_at = new Date().toISOString()
      try { await storage('readwrite', store => store.put(job)) } finally { pending.delete(job.id) }
    }
  })().catch(() => { pending.delete(job.id) })
  return { job }
}

const portalAPI = {
  getBranding: async (): Promise<SiteBranding> => responseJSON(await fetch('/api/branding')),
  // Standard image endpoints do not expose account balance. Never fabricate it.
  getPortalImageQuota: async (_key: string): Promise<ImageStudioQuota | null> => null,
  createPortalImageJob: (key: string, payload: CreateImageJobPayload) => create(key, payload, false),
  createPortalImageEditJob: (key: string, payload: CreateImageJobPayload) => create(key, payload, true),
  getPortalImageJobs: async (key: string, params = {}) => { const all = await jobs(key); return { jobs: paginate(all, params), total: all.length } },
  getPortalImageJob: async (key: string, id: number, _params = {}) => ({ job: await jobById(key, id) }),
  deletePortalImageJob: async (key: string, id: number) => { await jobById(key, id); await storage('readwrite', store => store.delete(id)) },
  getPortalImageAssets: async (key: string, params = {}) => { const assets = (await jobs(key)).flatMap(j => j.assets || []); return { assets: paginate(assets, params), total: assets.length } },
  getPortalImageAssetFile: async (key: string, id: number, _download = false): Promise<Blob> => {
    const asset = (await jobs(key)).flatMap(j => j.assets || []).find(a => a.id === id)
    if (!asset) throw new Error('未找到此图片')
    const response = await fetch(asset.cache_b64_json ? `data:${asset.mime_type};base64,${asset.cache_b64_json}` : asset.proxy_url!)
    if (!response.ok) throw new Error('下载图片失败')
    return response.blob()
  },
  deletePortalImageAsset: async (key: string, id: number) => {
    const job = (await jobs(key)).find(j => j.assets?.some(a => a.id === id))
    if (!job) throw new Error('未找到此图片')
    job.assets = job.assets?.filter(a => a.id !== id)
    await storage('readwrite', store => store.put(job))
  },

}

const templateStorageKey = 'image_studio_templates'
function readTemplates(): ImagePromptTemplate[] {
  const value = JSON.parse(localStorage.getItem(templateStorageKey) || '[]')
  if (!Array.isArray(value)) throw new Error('提示词资料库格式错误')
  return value
}
function writeTemplates(templates: ImagePromptTemplate[]) {
  // Persist before updating the UI, so quota/storage errors are shown to the user.
  localStorage.setItem(templateStorageKey, JSON.stringify(templates))
}
export const api = {
  ...portalAPI,
  getImagePromptTemplates: async () => ({ templates: readTemplates() }),
  createImagePromptTemplate: async (data: ImagePromptTemplatePayload) => {
    const now = new Date().toISOString()
    const template: ImagePromptTemplate = { id: Date.now(), name: '', prompt: '', model: 'gpt-image-2', size: '', quality: '', output_format: 'png', background: '', style: '', tags: [], favorite: false, usage_count: 0, created_at: now, updated_at: now, ...data }
    writeTemplates([template, ...readTemplates()]); return { template }
  },
  updateImagePromptTemplate: async (id: number, data: ImagePromptTemplatePayload) => {
    const templates = readTemplates(); const index = templates.findIndex(t => t.id === id)
    if (index < 0) throw new Error('模板不存在')
    const template = { ...templates[index], ...data, updated_at: new Date().toISOString() }
    templates[index] = template; writeTemplates(templates); return { template }
  },
  deleteImagePromptTemplate: async (id: number) => { writeTemplates(readTemplates().filter(t => t.id !== id)) },
  getImageJobs: async (params = {}) => { const key = readStoredAPIKey().key; return key ? portalAPI.getPortalImageJobs(key, params) : { jobs: [], total: 0 } },
  getImageAssets: async (params = {}) => { const key = readStoredAPIKey().key; return key ? portalAPI.getPortalImageAssets(key, params) : { assets: [], total: 0 } },
  getImageJob: async (id: number, params = {}) => portalAPI.getPortalImageJob(await requireKey(), id, params),
  getImageAssetFile: async (id: number, download = false): Promise<Blob> => portalAPI.getPortalImageAssetFile(await requireKey(), id, download),
  deleteImageAsset: async (id: number) => portalAPI.deletePortalImageAsset(await requireKey(), id),
  deleteImageJob: async (id: number) => portalAPI.deletePortalImageJob(await requireKey(), id),
  createImageJob: async (payload: CreateImageJobPayload) => { const result = await portalAPI.createPortalImageJob(await requireKey(), payload); recordTemplateUsage(payload.template_id); return result },
  createImageEditJob: async (payload: CreateImageJobPayload) => { const result = await portalAPI.createPortalImageEditJob(await requireKey(), payload); recordTemplateUsage(payload.template_id); return result },
}

function recordTemplateUsage(id?: number) {
  if (!id) return
  try { writeTemplates(readTemplates().map(t => t.id === id ? { ...t, usage_count: (t.usage_count || 0) + 1, last_used_at: new Date().toISOString() } : t)) } catch { /* A queued generation must still be returned if usage statistics cannot be saved. */ }
}
