import { readStoredAPIKey } from './studioKey'
export type KeyRequest = { resolve: (key: string) => void; reject: (error: Error) => void }
export async function requireKey(): Promise<string> {
  const key = readStoredAPIKey().key
  if (key) return key
  return new Promise((resolve, reject) => {
    window.dispatchEvent(new CustomEvent<KeyRequest>('studio:request-key', { detail: { resolve, reject } }))
  })
}
