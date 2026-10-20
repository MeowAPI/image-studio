import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'

const original = new URL('../../frontend/src/', import.meta.url)
const extracted = new URL('../src/', import.meta.url)
test('unchanged studio styles and shared components match original sources', {skip: !existsSync(original)}, async () => {
  const adapted = new Set(['api.ts', 'main.tsx', 'types.ts', 'lib/auth.ts', 'lib/legacyHistory.ts', 'components/StudioLoginDialog.tsx', 'components/image-studio/StudioAccountNotice.tsx'])
  // User-requested changes intentionally diverge from the original page.
  const customized = new Set(['pages/ImageStudio.tsx', 'pages/image-studio.css', 'pages/image-studio-collections.css', 'lib/imageStudioModels.ts', 'locales/zh.json', 'locales/en.json'])
  const report = []
  async function compare(directory = '') {
    for (const entry of await readdir(new URL(directory, extracted), {withFileTypes:true})) {
      const path = directory + entry.name
      if (entry.isDirectory()) { await compare(path + '/'); continue }
      if (adapted.has(path)) continue
      const source = await readFile(new URL(path, original))
      const copy = await readFile(new URL(path, extracted))
      if (customized.has(path)) {
        report.push({file:path, identical:copy.equals(source), customized:true, reason:'User-requested layout, base models, independent resolution, and image clarity controls'})
        continue
      }
      assert.deepEqual(copy, source, path)
      report.push({file:path, identical:true, sha256:createHash('sha256').update(copy).digest('hex')})
    }
  }
  await compare()
  await mkdir('artifacts', {recursive:true})
  await writeFile('artifacts/source-parity.json', JSON.stringify(report,null,2)+'\n')
})
