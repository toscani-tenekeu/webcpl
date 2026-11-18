<script setup lang="ts">
import { ArchiveRestoreIcon, DownloadIcon, HistoryIcon, PlusIcon, Trash2Icon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import ConfirmDialog from '@/components/app/ConfirmDialog.vue'
import LoadError from '@/components/LoadError.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useResource } from '@/composables/useResource'
import { del, messageOf, post } from '@/lib/api'
import { bytes, date } from '@/lib/format'
import { t } from '@/lib/i18n'

interface Backup { name: string; size: number; createdAt: number }
interface Job { kind: 'backup' | 'restore'; state: 'queued' | 'running' | 'done' | 'failed'; detail: string; at: number }
const { data, error, reload } = useResource<{ backups: Backup[]; job: Job | null; schedule: { schedule: string; hour: number; keep: number; offsite: boolean } }>(
  '/api/backups', (d) => (d?.job && (d.job.state === 'queued' || d.job.state === 'running') ? 3000 : 30000))
const busy = computed(() => data.value?.job?.state === 'queued' || data.value?.job?.state === 'running')
const kind = (b: Backup) => (b.name.endsWith('-auto.tar.zst') ? 'Scheduled' : 'On demand')

// Tell the user once when a job they watched finishes.
watch(() => data.value?.job?.state, (state, before) => {
  if (!before || before === state) return
  if (state === 'done') toast.success(data.value!.job!.kind === 'backup' ? t('Backup finished') : t('Restore finished'))
  if (state === 'failed') toast.error(data.value!.job!.detail)
})

async function create() {
  try {
    await post('/api/backups')
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}

const restoring = ref<Backup | null>(null)
const restoreOpen = computed({ get: () => !!restoring.value, set: (v) => { if (!v) restoring.value = null } })
const parts = ref({ files: true, databases: true })
async function restore() {
  await post(`/api/backups/${restoring.value!.name}/restore`, parts.value)
  await reload()
}
const removing = ref<Backup | null>(null)
const removeOpen = computed({ get: () => !!removing.value, set: (v) => { if (!v) removing.value = null } })
const download = (b: Backup) => window.open(`/api/backups/${b.name}/download`, '_blank')
const scheduleText = computed(() => {
  const s = data.value?.schedule
  if (!s || s.schedule === 'off') return t('The server makes no scheduled backups. Make one yourself before big changes.')
  return t(s.schedule === 'daily' ? 'Backed up every day at {h}:00; the last {k} are kept.' : 'Backed up every Sunday at {h}:00; the last {k} are kept.', { h: String(s.hour).padStart(2, '0'), k: s.keep })
})
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">{{ t('Backups') }}</h2>
      <p class="text-muted-foreground mt-1 text-sm">{{ t('Your files, mail, apps and databases.') }} {{ scheduleText }}</p>
    </div>
    <Button :disabled="busy" @click="create"><Spinner v-if="busy" data-icon="inline-start" /><PlusIcon v-else data-icon="inline-start" /> {{ t('Back up now') }}</Button>
  </div>
  <LoadError :message="data ? '' : error" />

  <Alert v-if="busy">
    <Spinner />
    <AlertTitle>{{ data!.job!.kind === 'backup' ? t('Backing up…') : t('Restoring…') }}</AlertTitle>
    <AlertDescription>{{ t('This runs on the server; you can leave this page.') }}</AlertDescription>
  </Alert>

  <Card v-if="data && data.backups.length" class="py-0">
    <CardContent class="px-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="pl-4">{{ t('Date') }}</TableHead><TableHead>{{ t('Type') }}</TableHead>
            <TableHead class="text-right">{{ t('Size') }}</TableHead><TableHead class="w-40 pr-4 text-right">{{ t('Actions') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="b in data.backups" :key="b.name">
            <TableCell class="pl-4">{{ date(b.createdAt) }}</TableCell>
            <TableCell><Badge variant="secondary">{{ t(kind(b)) }}</Badge></TableCell>
            <TableCell class="text-right font-mono text-xs">{{ bytes(b.size) }}</TableCell>
            <TableCell class="pr-4">
              <div class="flex justify-end gap-0.5">
                <Button size="sm" variant="outline" :disabled="busy" @click="parts = { files: true, databases: true }; restoring = b"><HistoryIcon data-icon="inline-start" /> {{ t('Restore') }}</Button>
                <Button size="icon-sm" variant="ghost" :aria-label="t('Download')" @click="download(b)"><DownloadIcon /></Button>
                <Button size="icon-sm" variant="ghost" class="text-destructive" :disabled="busy" :aria-label="t('Delete')" @click="removing = b"><Trash2Icon /></Button>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </CardContent>
  </Card>
  <Card v-else-if="data">
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><ArchiveRestoreIcon /></EmptyMedia>
        <EmptyTitle>{{ t('No backups yet') }}</EmptyTitle>
        <EmptyDescription>{{ t('Make one now; it appears here when it is done.') }}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  </Card>
  <Skeleton v-else-if="!error" class="h-40 rounded-xl" />

  <ConfirmDialog v-model:open="restoreOpen" :title="t('Restore this backup?')" :description="t('What you choose is put back as it was on {d}. Newer changes to it are overwritten.', { d: restoring ? date(restoring.createdAt) : '' })" :action="t('Restore')" destructive :confirm="restore">
    <div class="flex flex-col gap-2 text-sm">
      <label class="flex items-center gap-2"><Checkbox v-model="parts.files" /> {{ t('Files and mail') }}</label>
      <label class="flex items-center gap-2"><Checkbox v-model="parts.databases" /> {{ t('Databases') }}</label>
    </div>
  </ConfirmDialog>
  <ConfirmDialog v-model:open="removeOpen" :title="t('Delete this backup?')" :description="t('It cannot be restored afterwards.')" :action="t('Delete')" destructive
    :confirm="async () => { await del(`/api/backups/${removing!.name}`); await reload() }" />
</template>
