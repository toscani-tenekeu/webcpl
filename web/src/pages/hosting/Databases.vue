<script setup lang="ts">
import { DatabaseIcon, ExternalLinkIcon, KeyRoundIcon, PlusIcon, Trash2Icon, ZapIcon } from '@lucide/vue'
import CopyLine from '@/components/app/CopyLine.vue'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import ConfirmDialog from '@/components/app/ConfirmDialog.vue'
import SecretDialog from '@/components/app/SecretDialog.vue'
import LoadError from '@/components/LoadError.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useResource } from '@/composables/useResource'
import { user } from '@/composables/useSession'
import { api, messageOf, post, put } from '@/lib/api'
import { bytes } from '@/lib/format'
import { t } from '@/lib/i18n'

interface Database { id: number; name: string; user: string; engine: 'mariadb' | 'postgresql'; remote: boolean; size: number; createdAt: number }
const { data, error, reload } = useResource<{ databases: Database[]; engines: ('mariadb' | 'postgresql')[]; adminer: string | null }>('/api/databases')
const engine = ref<'mariadb' | 'postgresql'>('mariadb')
const ENGINE_LABEL = { mariadb: 'MariaDB', postgresql: 'PostgreSQL' }
const redis = useResource<{ available: boolean; enabled: boolean; active?: boolean; usedBytes?: number; memoryMb?: number; socket?: string }>('/api/redis')
const redisBusy = ref(false)
async function setRedis(enabled: boolean) {
  redisBusy.value = true
  try {
    await put('/api/redis', { enabled })
    toast.success(enabled ? t('Redis is on') : t('Redis is off'))
    await redis.reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  redisBusy.value = false
}
function adminerLink(d: Database) {
  const base = data.value?.adminer
  if (!base) return null
  const server = d.engine === 'postgresql' ? 'pgsql=localhost' : 'server=localhost'
  return `${base}?${server}&username=${encodeURIComponent(d.user)}&db=${encodeURIComponent(d.name)}`
}
const suffix = ref('')
const busy = ref(false)
const secret = ref<{ title: string; text: string } | null>(null)
const removing = ref<Database | null>(null)
const removeOpen = computed({ get: () => !!removing.value, set: (v) => { if (!v) removing.value = null } })

async function create() {
  busy.value = true
  try {
    const r = await post<{ database: { name: string }; password: string }>('/api/databases', { name: suffix.value, engine: engine.value })
    secret.value = { title: t('Database {n} is ready', { n: r.database.name }), text: r.password }
    suffix.value = ''
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  busy.value = false
}

async function newPassword(d: Database) {
  try {
    const r = await post<{ password: string }>(`/api/databases/${d.id}/password`)
    secret.value = { title: t('New password for {n}', { n: d.user }), text: r.password }
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}

async function setRemote(d: Database, remote: boolean) {
  try {
    await api(`/api/databases/${d.id}`, { method: 'PATCH', body: { remote } })
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}
</script>

<template>
  <div>
    <h2 class="text-2xl font-semibold tracking-tight">{{ t('Databases') }}</h2>
    <p class="text-muted-foreground mt-1 text-sm">{{ t('Each database gets a user of the same name. Connect to localhost from your sites.') }}</p>
  </div>
  <LoadError :message="data ? '' : error" />

  <Card>
    <CardHeader><CardTitle>{{ t('New database') }}</CardTitle></CardHeader>
    <CardContent>
      <form class="flex flex-wrap gap-2" @submit.prevent="create">
        <Select v-if="data && data.engines.length > 1" v-model="engine">
          <SelectTrigger class="w-36"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem v-for="e in data.engines" :key="e" :value="e">{{ ENGINE_LABEL[e] }}</SelectItem></SelectContent>
        </Select>
        <InputGroup class="w-72">
          <InputGroupAddon class="font-mono">{{ user?.username }}_</InputGroupAddon>
          <InputGroupInput :model-value="suffix" class="font-mono" placeholder="wordpress" maxlength="32" @update:model-value="(v: string | number) => (suffix = String(v).toLowerCase().replace(/[^a-z0-9]/g, ''))" />
        </InputGroup>
        <Button type="submit" :disabled="busy || !suffix"><Spinner v-if="busy" data-icon="inline-start" /><PlusIcon v-else data-icon="inline-start" /> {{ t('Create') }}</Button>
      </form>
    </CardContent>
  </Card>

  <Card v-if="data && data.databases.length" class="py-0">
    <CardContent class="px-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="pl-4">{{ t('Database and user') }}</TableHead>
            <TableHead class="text-right">{{ t('Size') }}</TableHead>
            <TableHead>{{ t('Remote access') }}</TableHead>
            <TableHead class="w-24 pr-4 text-right">{{ t('Actions') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="d in data.databases" :key="d.id">
            <TableCell class="pl-4"><span class="font-mono">{{ d.name }}</span> <Badge variant="outline" class="ml-1">{{ ENGINE_LABEL[d.engine] }}</Badge></TableCell>
            <TableCell class="text-right font-mono text-xs">{{ bytes(d.size) }}</TableCell>
            <TableCell><Switch v-if="d.engine === 'mariadb'" :model-value="d.remote" :aria-label="t('Remote access')" @update:model-value="(v) => setRemote(d, v)" /><span v-else class="text-muted-foreground text-xs">—</span></TableCell>
            <TableCell class="pr-4">
              <div class="flex justify-end gap-0.5">
                <Button v-if="adminerLink(d)" size="icon-sm" variant="ghost" :aria-label="t('Open in Adminer')" as-child><a :href="adminerLink(d)!" target="_blank" rel="noreferrer"><ExternalLinkIcon /></a></Button>
                <Button size="icon-sm" variant="ghost" :aria-label="t('New password')" @click="newPassword(d)"><KeyRoundIcon /></Button>
                <Button size="icon-sm" variant="ghost" class="text-destructive" :aria-label="t('Delete')" @click="removing = d"><Trash2Icon /></Button>
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
        <EmptyMedia variant="icon"><DatabaseIcon /></EmptyMedia>
        <EmptyTitle>{{ t('No databases yet') }}</EmptyTitle>
        <EmptyDescription>{{ t('Create one for WordPress or any other app.') }}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  </Card>
  <Skeleton v-else-if="!error" class="h-40 rounded-xl" />

  <Card v-if="redis.data.value?.available">
    <CardHeader>
      <CardTitle class="flex items-center gap-2"><ZapIcon class="size-4" /> Redis</CardTitle>
      <CardDescription>{{ t('A private Redis for your sites, with {m} MB of memory, reachable only through a socket in your home folder.', { m: redis.data.value.memoryMb ?? 0 }) }}</CardDescription>
      <CardAction><Switch :model-value="redis.data.value.enabled" :disabled="redisBusy" :aria-label="t('Redis')" @update:model-value="setRedis" /></CardAction>
    </CardHeader>
    <CardContent v-if="redis.data.value.enabled" class="flex flex-col gap-2">
      <CopyLine :text="redis.data.value.socket ?? ''" />
      <p class="text-muted-foreground text-xs">
        {{ redis.data.value.active ? t('Running, using {u}.', { u: bytes(redis.data.value.usedBytes ?? 0) }) : t('Not running.') }}
      </p>
    </CardContent>
  </Card>
  <p v-if="data?.adminer" class="text-muted-foreground text-sm">
    {{ t('Manage tables and data in Adminer:') }} <a :href="data.adminer" target="_blank" rel="noreferrer" class="text-foreground font-mono hover:underline">{{ data.adminer }}</a>.
    {{ t('SQLite needs nothing: PHP opens database files in your folder.') }}
  </p>

  <SecretDialog :title="secret?.title ?? ''" :description="t('Its password is shown once. Put it in your app’s settings now.')" :secret="secret?.text ?? null" @close="secret = null" />
  <ConfirmDialog
    v-model:open="removeOpen"
    :title="t('Delete {n}?', { n: removing?.name ?? '' })"
    :description="t('The database and everything in it are removed for good.')"
    :word="removing?.name"
    :action="t('Delete database')"
    destructive
    :confirm="async () => { await api(`/api/databases/${removing!.id}`, { method: 'DELETE', body: { confirm: removing!.name } }); await reload() }"
  />
</template>
