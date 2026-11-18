<script setup lang="ts">
import { ChevronRightIcon, DownloadIcon, PlayIcon, PlusIcon, RefreshCwIcon, RotateCwIcon, SaveIcon, SquareIcon, Trash2Icon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import AppState from '@/components/app/AppState.vue'
import ConfirmDialog from '@/components/app/ConfirmDialog.vue'
import LoadError from '@/components/LoadError.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useResource } from '@/composables/useResource'
import { api, messageOf, post } from '@/lib/api'
import { bytes, date } from '@/lib/format'
import { t } from '@/lib/i18n'
import type { App, AppsResponse } from '@/lib/types'

const route = useRoute()
const router = useRouter()
const id = computed(() => Number(route.params.id))
const tab = computed(() => String(route.params.tab || 'overview'))
const goTab = (value: string | number) => router.replace(value === 'overview' ? `/apps/${id.value}` : `/apps/${id.value}/${value}`)
const { data, error, reload } = useResource<AppsResponse>('/api/apps', 5000)
const app = computed(() => data.value?.apps.find((a) => a.id === id.value))
const LABEL = { node: 'Node.js', python: 'Python', ruby: 'Ruby' } as const

// ---- settings ----
const form = ref({ command: '', version: '', root: '', domainId: 'none' })
watch(app, (a, old) => {
  if (a && a.id !== old?.id) form.value = { command: a.command, version: a.version, root: a.root, domainId: a.domainId ? String(a.domainId) : 'none' }
}, { immediate: true })
const saving = ref(false)
async function save(body: Record<string, unknown>, done = t('Saved')) {
  saving.value = true
  try {
    await api(`/api/apps/${id.value}`, { method: 'PATCH', body })
    toast.success(done)
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  saving.value = false
}
const saveSettings = () => save({ command: form.value.command, version: form.value.version, root: form.value.root, domainId: form.value.domainId === 'none' ? null : Number(form.value.domainId) })

// ---- power and install ----
const powering = ref('')
async function power(action: string) {
  powering.value = action
  try {
    await post(`/api/apps/${id.value}/power`, { action })
    await new Promise((r) => setTimeout(r, 1200))
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  powering.value = ''
}
const installing = ref(false)
const installOutput = ref<{ ok: boolean; output: string } | null>(null)
async function install() {
  installing.value = true
  installOutput.value = null
  try {
    await post(`/api/apps/${id.value}/install`)
    // The installation runs on the server; ask for its result every two seconds.
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000))
      const r = await api<{ running: boolean; ok: boolean | null; output: string }>(`/api/apps/${id.value}/install`)
      if (!r.running) {
        installOutput.value = { ok: !!r.ok, output: r.output }
        break
      }
    }
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  installing.value = false
}

// ---- environment ----
const envRows = ref<{ key: string; value: string }[]>([])
watch(app, (a, old) => { if (a && a.id !== old?.id) envRows.value = Object.entries(a.env).map(([key, value]) => ({ key, value })) }, { immediate: true })
const saveEnv = () => save({ env: Object.fromEntries(envRows.value.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value])) }, t('Variables saved. Restart the app to use them.'))

// ---- logs ----
const logs = ref('')
const logsLoading = ref(false)
async function loadLogs() {
  logsLoading.value = true
  try {
    logs.value = (await api<{ text: string }>(`/api/apps/${id.value}/logs?lines=300`)).text
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  logsLoading.value = false
}
watch(tab, (v) => { if (v === 'logs') void loadLogs() }, { immediate: true })

const removeOpen = ref(false)
async function remove() {
  await api(`/api/apps/${id.value}`, { method: 'DELETE', body: { confirm: app.value!.name } })
  toast.success(t('{d} deleted', { d: app.value!.name }))
  await router.push('/apps')
}
const running = computed(() => app.value?.state === 'active' || app.value?.state === 'activating')
</script>

<template>
  <LoadError :message="data ? '' : error" />
  <template v-if="app && data">
    <nav class="text-muted-foreground flex items-center gap-1 text-sm">
      <RouterLink to="/apps" class="hover:text-foreground">{{ t('Apps') }}</RouterLink>
      <ChevronRightIcon class="size-3.5" />
      <span class="text-foreground font-mono">{{ app.name }}</span>
    </nav>
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="flex items-center gap-3 font-mono text-2xl font-semibold tracking-tight">{{ app.name }} <AppState :state="app.state" class="font-sans" /></h2>
        <p class="text-muted-foreground mt-1 text-sm">{{ LABEL[app.runtime] }} {{ app.version }} · <span class="font-mono">~/{{ app.root }}</span> · {{ t('port {p}', { p: app.port }) }}</p>
      </div>
      <div class="flex gap-2">
        <Button v-if="!running" :disabled="!!powering" @click="power('start')"><Spinner v-if="powering === 'start'" data-icon="inline-start" /><PlayIcon v-else data-icon="inline-start" /> {{ t('Start') }}</Button>
        <template v-else>
          <Button variant="outline" :disabled="!!powering" @click="power('restart')"><Spinner v-if="powering === 'restart'" data-icon="inline-start" /><RotateCwIcon v-else data-icon="inline-start" /> {{ t('Restart') }}</Button>
          <Button variant="outline" :disabled="!!powering" @click="power('stop')"><Spinner v-if="powering === 'stop'" data-icon="inline-start" /><SquareIcon v-else data-icon="inline-start" /> {{ t('Stop') }}</Button>
        </template>
      </div>
    </div>

    <Tabs :model-value="tab" @update:model-value="goTab">
      <TabsList>
        <TabsTrigger value="overview" class="px-3">{{ t('Overview') }}</TabsTrigger>
        <TabsTrigger value="env" class="px-3">{{ t('Environment') }}</TabsTrigger>
        <TabsTrigger value="logs" class="px-3">{{ t('Logs') }}</TabsTrigger>
      </TabsList>
    </Tabs>

    <template v-if="tab === 'overview'">
      <div class="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{{ t('Dependencies') }}</CardTitle>
            <CardDescription>{{ app.runtime === 'node' ? t('Runs npm ci, or npm install, in the app folder.') : app.runtime === 'python' ? t('Creates .venv and installs requirements.txt into it.') : t('Runs bundle install into vendor/bundle.') }}</CardDescription>
            <CardAction><Button variant="outline" :disabled="installing" @click="install"><Spinner v-if="installing" data-icon="inline-start" /><DownloadIcon v-else data-icon="inline-start" /> {{ t('Install') }}</Button></CardAction>
          </CardHeader>
          <CardContent v-if="installOutput">
            <p class="mb-2 text-sm" :class="installOutput.ok ? 'text-emerald-600' : 'text-destructive'">{{ installOutput.ok ? t('Dependencies installed.') : t('The installation failed.') }}</p>
            <pre class="bg-muted max-h-72 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">{{ installOutput.output || '—' }}</pre>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{{ t('Status') }}</CardTitle></CardHeader>
          <CardContent class="flex flex-col gap-1 text-sm">
            <p><span class="text-muted-foreground">{{ t('Memory') }}:</span> <span class="font-mono">{{ app.memoryBytes !== null ? bytes(app.memoryBytes) : '—' }}</span></p>
            <p v-if="app.since && running"><span class="text-muted-foreground">{{ t('Started') }}:</span> {{ date(app.since) }}</p>
            <p><span class="text-muted-foreground">{{ t('Restarts') }}:</span> {{ app.restarts }}</p>
            <p v-if="app.domain"><span class="text-muted-foreground">{{ t('Website') }}:</span> <a :href="`http://${app.domain}`" target="_blank" rel="noreferrer" class="font-mono hover:underline">{{ app.domain }}</a></p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle>{{ t('Settings') }}</CardTitle><CardDescription>{{ t('Listen on 127.0.0.1 and the port in $PORT ({p}).', { p: app.port }) }}</CardDescription></CardHeader>
        <CardContent>
          <form class="grid gap-4 md:grid-cols-2" @submit.prevent="saveSettings">
            <Field class="md:col-span-2">
              <FieldLabel for="a-cmd">{{ t('Start command') }}</FieldLabel>
              <Input id="a-cmd" v-model="form.command" class="font-mono" />
            </Field>
            <Field>
              <FieldLabel for="a-root">{{ t('Folder') }}</FieldLabel>
              <Input id="a-root" v-model="form.root" class="font-mono" />
            </Field>
            <Field>
              <FieldLabel>{{ t('Version') }}</FieldLabel>
              <Select v-model="form.version">
                <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem v-for="v in data.runtimes[app.runtime]" :key="v" :value="v">{{ LABEL[app.runtime] }} {{ v }}</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field class="md:col-span-2">
              <FieldLabel>{{ t('Website') }}</FieldLabel>
              <Select v-model="form.domainId">
                <SelectTrigger class="w-full md:w-80"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{{ t('None') }}</SelectItem>
                  <SelectItem v-for="d in data.domains" :key="d.id" :value="String(d.id)">{{ d.name }}</SelectItem>
                </SelectContent>
              </Select>
              <FieldDescription>{{ t('The website then shows this app instead of its PHP files.') }}</FieldDescription>
            </Field>
            <div><Button type="submit" :disabled="saving"><Spinner v-if="saving" data-icon="inline-start" /><SaveIcon v-else data-icon="inline-start" /> {{ t('Save') }}</Button></div>
          </form>
        </CardContent>
      </Card>
      <Card class="border-destructive/30">
        <CardHeader>
          <CardTitle class="flex items-center gap-2"><Trash2Icon class="size-4" /> {{ t('Delete this app') }}</CardTitle>
          <CardDescription>{{ t('The app stops and its service is removed. Its folder stays in your home.') }}</CardDescription>
          <CardAction><Button variant="destructive" @click="removeOpen = true"><Trash2Icon data-icon="inline-start" /> {{ t('Delete…') }}</Button></CardAction>
        </CardHeader>
      </Card>
    </template>

    <Card v-else-if="tab === 'env'">
      <CardHeader>
        <CardTitle>{{ t('Environment variables') }}</CardTitle>
        <CardDescription>{{ t('PORT, HOST, PATH, HOME and USER are set by the panel.') }}</CardDescription>
        <CardAction class="flex gap-2">
          <Button variant="outline" @click="envRows.push({ key: '', value: '' })"><PlusIcon data-icon="inline-start" /> {{ t('Add') }}</Button>
          <Button :disabled="saving" @click="saveEnv"><Spinner v-if="saving" data-icon="inline-start" /><SaveIcon v-else data-icon="inline-start" /> {{ t('Save') }}</Button>
        </CardAction>
      </CardHeader>
      <CardContent class="flex flex-col gap-2">
        <p v-if="!envRows.length" class="text-muted-foreground text-sm">{{ t('No variables yet.') }}</p>
        <div v-for="(r, i) in envRows" :key="i" class="flex gap-2">
          <Input v-model="r.key" class="w-56 font-mono text-xs" placeholder="DATABASE_URL" />
          <Input v-model="r.value" class="flex-1 font-mono text-xs" />
          <Button size="icon" variant="ghost" class="text-destructive" :aria-label="t('Delete')" @click="envRows.splice(i, 1)"><Trash2Icon /></Button>
        </div>
      </CardContent>
    </Card>

    <Card v-else-if="tab === 'logs'">
      <CardHeader>
        <CardTitle>{{ t('Logs') }}</CardTitle>
        <CardDescription>{{ t('What the app printed, newest last.') }}</CardDescription>
        <CardAction><Button variant="outline" size="icon" :aria-label="t('Refresh')" :disabled="logsLoading" @click="loadLogs"><RefreshCwIcon /></Button></CardAction>
      </CardHeader>
      <CardContent>
        <pre class="max-h-[60vh] overflow-auto rounded-md bg-[#0f1115] p-3 font-mono text-xs whitespace-pre-wrap text-[#e6e6e6]">{{ logs || t('No output yet.') }}</pre>
      </CardContent>
    </Card>

    <ConfirmDialog v-model:open="removeOpen" :title="t('Delete {n}?', { n: app.name })" :description="t('The app stops and its service is removed. Its folder stays in your home.')" :word="app.name" :action="t('Delete app')" destructive :confirm="remove" />
  </template>
  <Skeleton v-else-if="!error" class="h-80 rounded-xl" />
</template>
