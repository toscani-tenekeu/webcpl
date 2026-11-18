<script setup lang="ts">
import { CodeIcon, PlusIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppState from '@/components/app/AppState.vue'
import LoadError from '@/components/LoadError.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useResource } from '@/composables/useResource'
import { messageOf, post } from '@/lib/api'
import { t } from '@/lib/i18n'
import type { App, AppsResponse } from '@/lib/types'

const router = useRouter()
const { data, error } = useResource<AppsResponse>('/api/apps', 10000)
const LABEL = { node: 'Node.js', python: 'Python', ruby: 'Ruby' } as const
const runtimes = computed(() => (Object.keys(LABEL) as (keyof typeof LABEL)[]).filter((r) => (data.value?.runtimes[r] ?? []).length))

const creating = ref(false)
const form = ref({ name: '', runtime: 'node' as App['runtime'], version: '', root: '', command: '', domainId: '' })
const busy = ref(false)
const formError = ref('')
function openCreate() {
  const runtime = runtimes.value[0] ?? 'node'
  form.value = { name: '', runtime, version: data.value?.runtimes[runtime].at(-1) ?? '', root: '', command: data.value?.defaults[runtime] ?? '', domainId: '' }
  formError.value = ''
  creating.value = true
}
watch(() => form.value.runtime, (r) => {
  form.value.version = data.value?.runtimes[r].at(-1) ?? ''
  form.value.command = data.value?.defaults[r] ?? ''
})
async function create() {
  busy.value = true
  formError.value = ''
  try {
    const r = await post<{ app: App }>('/api/apps', { ...form.value, root: form.value.root || `apps/${form.value.name}`, domainId: form.value.domainId ? Number(form.value.domainId) : null })
    creating.value = false
    await router.push(`/apps/${r.app.id}`)
  } catch (failure) {
    formError.value = messageOf(failure)
  }
  busy.value = false
}
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">{{ t('Apps') }}</h2>
      <p class="text-muted-foreground mt-1 text-sm">{{ t('Node.js, Python and Ruby applications, kept running and served on your websites.') }}</p>
    </div>
    <Button v-if="data && runtimes.length" @click="openCreate"><PlusIcon data-icon="inline-start" /> {{ t('New app') }}</Button>
  </div>
  <LoadError :message="data ? '' : error" />
  <Card v-if="data && !runtimes.length"><CardContent class="text-muted-foreground text-sm">{{ t('No runtime is installed on this server yet. Ask your provider.') }}</CardContent></Card>
  <Card v-else-if="data && data.apps.length" class="py-0">
    <CardContent class="px-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="pl-4">{{ t('Name') }}</TableHead><TableHead>{{ t('Status') }}</TableHead><TableHead>{{ t('Runtime') }}</TableHead>
            <TableHead>{{ t('Website') }}</TableHead><TableHead class="hidden pr-4 md:table-cell">{{ t('Folder') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="a in data.apps" :key="a.id" class="cursor-pointer" @click="router.push(`/apps/${a.id}`)">
            <TableCell class="pl-4 font-mono font-medium">{{ a.name }}</TableCell>
            <TableCell><AppState :state="a.state" /></TableCell>
            <TableCell>{{ LABEL[a.runtime] }} {{ a.version }}</TableCell>
            <TableCell class="font-mono text-sm">{{ a.domain ?? '—' }}</TableCell>
            <TableCell class="text-muted-foreground hidden pr-4 font-mono text-xs md:table-cell">~/{{ a.root }}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </CardContent>
  </Card>
  <Card v-else-if="data">
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><CodeIcon /></EmptyMedia>
        <EmptyTitle>{{ t('No apps yet') }}</EmptyTitle>
        <EmptyDescription>{{ t('Upload your code to a folder, create the app, install its dependencies and start it.') }}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent><Button @click="openCreate"><PlusIcon data-icon="inline-start" /> {{ t('New app') }}</Button></EmptyContent>
    </Empty>
  </Card>
  <Skeleton v-else-if="!error" class="h-40 rounded-xl" />

  <Dialog v-model:open="creating">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ t('New app') }}</DialogTitle>
        <DialogDescription>{{ t('The app listens on 127.0.0.1 and the port in $PORT; the website proxies to it.') }}</DialogDescription>
      </DialogHeader>
      <form v-if="data" id="new-app" class="flex flex-col gap-4" @submit.prevent="create">
        <div class="grid gap-4 sm:grid-cols-3">
          <Field class="sm:col-span-1">
            <FieldLabel for="app-name">{{ t('Name') }}</FieldLabel>
            <Input id="app-name" v-model="form.name" class="font-mono" placeholder="api" autocomplete="off" />
          </Field>
          <Field>
            <FieldLabel>{{ t('Runtime') }}</FieldLabel>
            <Select v-model="form.runtime">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem v-for="r in runtimes" :key="r" :value="r">{{ LABEL[r] }}</SelectItem></SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>{{ t('Version') }}</FieldLabel>
            <Select v-model="form.version">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem v-for="v in data.runtimes[form.runtime]" :key="v" :value="v">{{ v }}</SelectItem></SelectContent>
            </Select>
          </Field>
        </div>
        <Field>
          <FieldLabel for="app-root">{{ t('Folder') }}</FieldLabel>
          <Input id="app-root" v-model="form.root" class="font-mono" :placeholder="`apps/${form.name || 'api'}`" />
          <FieldDescription>{{ t('Inside your home folder. It is created if missing.') }}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel for="app-cmd">{{ t('Start command') }}</FieldLabel>
          <Input id="app-cmd" v-model="form.command" class="font-mono" />
        </Field>
        <Field>
          <FieldLabel>{{ t('Website') }}</FieldLabel>
          <Select v-model="form.domainId">
            <SelectTrigger class="w-full"><SelectValue :placeholder="t('None for now')" /></SelectTrigger>
            <SelectContent><SelectItem v-for="d in data.domains" :key="d.id" :value="String(d.id)">{{ d.name }}</SelectItem></SelectContent>
          </Select>
          <FieldDescription>{{ t('The website then shows this app instead of its PHP files.') }}</FieldDescription>
        </Field>
        <FieldError v-if="formError">{{ formError }}</FieldError>
      </form>
      <DialogFooter>
        <Button variant="outline" @click="creating = false">{{ t('Cancel') }}</Button>
        <Button type="submit" form="new-app" :disabled="busy || !form.name"><Spinner v-if="busy" data-icon="inline-start" /> {{ t('Create') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
