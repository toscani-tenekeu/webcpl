<script setup lang="ts">
import {
  ArchiveIcon, ChevronRightIcon, DownloadIcon, FileIcon, FilePlusIcon, FolderIcon, FolderPlusIcon, HomeIcon, LinkIcon,
  PencilIcon, RefreshCwIcon, ShieldIcon, Trash2Icon, UploadIcon,
} from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import ConfirmDialog from '@/components/app/ConfirmDialog.vue'
import LoadError from '@/components/LoadError.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { api, messageOf, post, put } from '@/lib/api'
import { bytes, shortDate } from '@/lib/format'
import { lang, t } from '@/lib/i18n'
import type { FileEntry } from '@/lib/types'

const route = useRoute()
const router = useRouter()
const path = computed(() => (typeof route.query.path === 'string' ? route.query.path : '/'))
const entries = ref<FileEntry[] | null>(null)
const error = ref('')
const selected = ref<Set<string>>(new Set())
const join = (dir: string, name: string) => `${dir.replace(/\/$/, '')}/${name}`
const crumbs = computed(() => {
  const parts = path.value.split('/').filter(Boolean)
  return parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join('/')}` }))
})

async function load() {
  error.value = ''
  try {
    entries.value = (await api<{ entries: FileEntry[] }>(`/api/files?path=${encodeURIComponent(path.value)}`)).entries
    selected.value = new Set()
  } catch (failure) {
    error.value = messageOf(failure)
  }
}
watch(path, load, { immediate: true })
const go = (p: string) => router.push({ query: { path: p } })

async function run(action: string, body: Record<string, unknown>, done?: string) {
  try {
    await post(`/api/files/${action}`, body)
    if (done) toast.success(done)
    await load()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}

// ---- name prompts ----
const prompt = ref<{ title: string; value: string; action: (value: string) => Promise<void> } | null>(null)
const promptOpen = computed({ get: () => !!prompt.value, set: (v) => { if (!v) prompt.value = null } })
async function submitPrompt() {
  const p = prompt.value!
  prompt.value = null
  await p.action(p.value.trim())
}
const newFolder = () => (prompt.value = { title: t('New folder'), value: '', action: (name) => run('mkdir', { path: path.value, name }) })
const newFile = () => (prompt.value = { title: t('New file'), value: '', action: (name) => run('create', { path: path.value, name }) })
const rename = (e: FileEntry) =>
  (prompt.value = { title: t('Rename {n}', { n: e.name }), value: e.name, action: (name) => run('rename', { path: join(path.value, e.name), to: join(path.value, name) }) })
const chmod = (e: FileEntry) =>
  (prompt.value = { title: t('Permissions of {n}', { n: e.name }), value: e.mode, action: (mode) => run('chmod', { path: join(path.value, e.name), mode }) })
const compress = () =>
  (prompt.value = { title: t('Compress {n} item(s)', { n: selected.value.size }), value: 'archive.zip', action: (archive) => run('compress', { folder: path.value, names: [...selected.value], archive }, t('Archive created')) })

// ---- open, edit, download ----
const editing = ref<{ path: string; content: string } | null>(null)
const editOpen = computed({ get: () => !!editing.value, set: (v) => { if (!v) editing.value = null } })
const saving = ref(false)
async function open(e: FileEntry) {
  if (e.type === 'dir') return go(join(path.value, e.name))
  try {
    const r = await api<{ content: string }>(`/api/files/content?path=${encodeURIComponent(join(path.value, e.name))}`)
    editing.value = { path: join(path.value, e.name), content: r.content }
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}
async function save() {
  saving.value = true
  try {
    await put('/api/files/content', editing.value)
    toast.success(t('Saved'))
    editing.value = null
    await load()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  saving.value = false
}
const download = (e: FileEntry) => window.open(`/api/files/download?path=${encodeURIComponent(join(path.value, e.name))}`, '_blank')

// ---- upload ----
const uploading = ref(false)
const picker = ref<HTMLInputElement>()
async function upload(files: FileList | File[] | null) {
  if (!files || !files.length) return
  uploading.value = true
  const form = new FormData()
  form.set('path', path.value)
  for (const f of files) form.append('file', f)
  try {
    const response = await fetch('/api/files/upload', { method: 'POST', body: form, headers: { 'x-webcpl': '1', 'x-lang': lang.value }, credentials: 'same-origin' })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.error ?? `Error ${response.status}`)
    toast.success(t('{n} file(s) uploaded', { n: data.count }))
    await load()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  uploading.value = false
}
const dragging = ref(false)

const removeOpen = ref(false)
const isArchive = (name: string) => /\.(zip|tar|tar\.gz|tgz|tar\.xz|tar\.bz2)$/i.test(name)
const toggle = (name: string, on: boolean) => {
  const next = new Set(selected.value)
  if (on) next.add(name)
  else next.delete(name)
  selected.value = next
}
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">{{ t('Files') }}</h2>
      <nav class="text-muted-foreground mt-1 flex flex-wrap items-center gap-1 font-mono text-sm">
        <button class="hover:text-foreground inline-flex items-center gap-1" @click="go('/')"><HomeIcon class="size-3.5" /> ~</button>
        <template v-for="c in crumbs" :key="c.path">
          <ChevronRightIcon class="size-3.5" />
          <button class="hover:text-foreground" @click="go(c.path)">{{ c.name }}</button>
        </template>
      </nav>
    </div>
    <div class="flex flex-wrap gap-2">
      <Button variant="outline" size="icon" :aria-label="t('Refresh')" @click="load"><RefreshCwIcon /></Button>
      <Button variant="outline" @click="newFolder"><FolderPlusIcon data-icon="inline-start" /> {{ t('Folder') }}</Button>
      <Button variant="outline" @click="newFile"><FilePlusIcon data-icon="inline-start" /> {{ t('File') }}</Button>
      <Button :disabled="uploading" @click="picker?.click()"><Spinner v-if="uploading" data-icon="inline-start" /><UploadIcon v-else data-icon="inline-start" /> {{ t('Upload') }}</Button>
      <input ref="picker" type="file" multiple hidden @change="(e) => { upload((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = '' }" />
    </div>
  </div>

  <div v-if="selected.size" class="bg-muted flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-sm">
    <span>{{ t('{n} selected', { n: selected.size }) }}</span>
    <Button size="sm" variant="outline" @click="compress"><ArchiveIcon data-icon="inline-start" /> {{ t('Compress') }}</Button>
    <Button size="sm" variant="outline" class="text-destructive" @click="removeOpen = true"><Trash2Icon data-icon="inline-start" /> {{ t('Delete') }}</Button>
  </div>

  <LoadError :message="error" />
  <Card
    v-if="entries"
    class="py-0 transition-colors"
    :class="dragging ? 'border-primary bg-primary/5' : ''"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="(e: DragEvent) => { dragging = false; upload(e.dataTransfer?.files ?? null) }"
  >
    <CardContent class="px-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="w-10 pl-4">
              <Checkbox :model-value="entries.length > 0 && selected.size === entries.length" :aria-label="t('Select all')" @update:model-value="(v) => (selected = new Set(v ? entries!.map((e) => e.name) : []))" />
            </TableHead>
            <TableHead>{{ t('Name') }}</TableHead>
            <TableHead class="text-right">{{ t('Size') }}</TableHead>
            <TableHead class="hidden md:table-cell">{{ t('Modified') }}</TableHead>
            <TableHead class="hidden sm:table-cell">{{ t('Mode') }}</TableHead>
            <TableHead class="w-40 pr-4 text-right">{{ t('Actions') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-if="path !== '/'" class="cursor-pointer" @click="go(path.split('/').slice(0, -1).join('/') || '/')">
            <TableCell class="pl-4" /><TableCell class="font-mono">..</TableCell><TableCell colspan="4" />
          </TableRow>
          <TableRow v-for="e in entries" :key="e.name">
            <TableCell class="pl-4"><Checkbox :model-value="selected.has(e.name)" @update:model-value="(v) => toggle(e.name, v === true)" /></TableCell>
            <TableCell class="max-w-0 w-full">
              <button class="flex max-w-full items-center gap-2 text-left hover:underline" @click="open(e)">
                <FolderIcon v-if="e.type === 'dir'" class="size-4 shrink-0 text-sky-500" />
                <LinkIcon v-else-if="e.type === 'link'" class="text-muted-foreground size-4 shrink-0" />
                <FileIcon v-else class="text-muted-foreground size-4 shrink-0" />
                <span class="truncate font-mono text-sm">{{ e.name }}</span>
                <span v-if="e.target" class="text-muted-foreground truncate text-xs">→ {{ e.target }}</span>
              </button>
            </TableCell>
            <TableCell class="text-right font-mono text-xs whitespace-nowrap">{{ e.type === 'dir' ? '' : bytes(e.size) }}</TableCell>
            <TableCell class="text-muted-foreground hidden text-xs whitespace-nowrap md:table-cell">{{ shortDate(e.modified) }}</TableCell>
            <TableCell class="hidden font-mono text-xs sm:table-cell">{{ e.mode }}</TableCell>
            <TableCell class="pr-4">
              <div class="flex justify-end gap-0.5">
                <Button v-if="e.type === 'file'" size="icon-sm" variant="ghost" :aria-label="t('Download')" @click="download(e)"><DownloadIcon /></Button>
                <Button v-if="isArchive(e.name)" size="icon-sm" variant="ghost" :aria-label="t('Extract here')" @click="run('extract', { path: join(path, e.name), into: path }, t('Extracted'))"><ArchiveIcon /></Button>
                <Button size="icon-sm" variant="ghost" :aria-label="t('Rename')" @click="rename(e)"><PencilIcon /></Button>
                <Button size="icon-sm" variant="ghost" :aria-label="t('Permissions')" @click="chmod(e)"><ShieldIcon /></Button>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p v-if="!entries.length" class="text-muted-foreground p-6 text-center text-sm">{{ t('This folder is empty. Drop files here to upload them.') }}</p>
    </CardContent>
  </Card>
  <Skeleton v-else-if="!error" class="h-80 rounded-xl" />

  <Dialog v-model:open="promptOpen">
    <DialogContent v-if="prompt" class="sm:max-w-md">
      <DialogHeader><DialogTitle>{{ prompt.title }}</DialogTitle><DialogDescription class="sr-only">{{ prompt.title }}</DialogDescription></DialogHeader>
      <form id="file-prompt" @submit.prevent="submitPrompt"><Input v-model="prompt.value" class="font-mono" autofocus /></form>
      <DialogFooter>
        <Button variant="outline" @click="prompt = null">{{ t('Cancel') }}</Button>
        <Button type="submit" form="file-prompt" :disabled="!prompt.value.trim()">{{ t('OK') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="editOpen">
    <DialogContent v-if="editing" class="flex max-h-[92svh] flex-col sm:max-w-4xl">
      <DialogHeader><DialogTitle class="font-mono text-sm">{{ editing.path }}</DialogTitle><DialogDescription class="sr-only">{{ t('Edit file') }}</DialogDescription></DialogHeader>
      <Textarea v-model="editing.content" spellcheck="false" class="min-h-[60svh] flex-1 resize-none font-mono text-xs" />
      <DialogFooter>
        <Button variant="outline" @click="editing = null">{{ t('Cancel') }}</Button>
        <Button :disabled="saving" @click="save"><Spinner v-if="saving" data-icon="inline-start" /> {{ t('Save') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <ConfirmDialog
    v-model:open="removeOpen"
    :title="t('Delete {n} item(s)?', { n: selected.size })"
    :description="t('Folders are deleted with everything inside. This cannot be undone.')"
    :action="t('Delete')"
    destructive
    :confirm="() => run('delete', { paths: [...selected].map((n) => join(path, n)) }, t('Deleted'))"
  />
</template>
