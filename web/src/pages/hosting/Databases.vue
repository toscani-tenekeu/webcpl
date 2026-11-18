<script setup lang="ts">
import { DatabaseIcon, KeyRoundIcon, PlusIcon, Trash2Icon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import ConfirmDialog from '@/components/app/ConfirmDialog.vue'
import SecretDialog from '@/components/app/SecretDialog.vue'
import LoadError from '@/components/LoadError.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useResource } from '@/composables/useResource'
import { user } from '@/composables/useSession'
import { api, messageOf, post } from '@/lib/api'
import { bytes } from '@/lib/format'
import { t } from '@/lib/i18n'

interface Database { id: number; name: string; user: string; remote: boolean; size: number; createdAt: number }
const { data, error, reload } = useResource<{ databases: Database[] }>('/api/databases')
const suffix = ref('')
const busy = ref(false)
const secret = ref<{ title: string; text: string } | null>(null)
const removing = ref<Database | null>(null)
const removeOpen = computed({ get: () => !!removing.value, set: (v) => { if (!v) removing.value = null } })

async function create() {
  busy.value = true
  try {
    const r = await post<{ database: { name: string }; password: string }>('/api/databases', { name: suffix.value })
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
    <p class="text-muted-foreground mt-1 text-sm">{{ t('MariaDB databases. Each one gets a user of the same name. Connect to localhost from your sites.') }}</p>
  </div>
  <LoadError :message="data ? '' : error" />

  <Card>
    <CardHeader><CardTitle>{{ t('New database') }}</CardTitle></CardHeader>
    <CardContent>
      <form class="flex flex-wrap gap-2" @submit.prevent="create">
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
            <TableCell class="pl-4 font-mono">{{ d.name }}</TableCell>
            <TableCell class="text-right font-mono text-xs">{{ bytes(d.size) }}</TableCell>
            <TableCell><Switch :model-value="d.remote" :aria-label="t('Remote access')" @update:model-value="(v) => setRemote(d, v)" /></TableCell>
            <TableCell class="pr-4">
              <div class="flex justify-end gap-0.5">
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
