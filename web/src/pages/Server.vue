<script setup lang="ts">
import { CpuIcon, NetworkIcon, PackageIcon, RotateCwIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import Fail2banTab from '@/components/server/Fail2banTab.vue'
import FirewallTab from '@/components/server/FirewallTab.vue'
import MetricsCard from '@/components/server/MetricsCard.vue'
import UpdatesTab from '@/components/server/UpdatesTab.vue'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import ConfirmDialog from '@/components/app/ConfirmDialog.vue'
import LoadError from '@/components/LoadError.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useResource } from '@/composables/useResource'
import { post } from '@/lib/api'
import { bytes, duration } from '@/lib/format'
import { t } from '@/lib/i18n'
import type { ComponentStatus, ServerInfo } from '@/lib/types'

const route = useRoute()
const router = useRouter()
const tab = computed(() => String(route.params.tab || 'overview'))
const goTab = (value: string | number) => router.replace(value === 'overview' ? '/server' : `/server/${value}`)
const { data, error, reload } = useResource<{ info: ServerInfo | { error: string }; components: ComponentStatus[] | null; version: string }>('/api/server', 15_000)
const info = computed(() => (data.value?.info && !('error' in data.value.info) ? data.value.info : null))
const agentError = computed(() => (data.value?.info && 'error' in data.value.info ? data.value.info.error : ''))
const installed = computed(() => (data.value?.components ?? []).filter((c) => c.installed))
const available = computed(() => (data.value?.components ?? []).filter((c) => !c.installed))

const tone = (state: string) =>
  state === 'active' ? 'bg-emerald-500' : state === 'failed' ? 'bg-red-500' : state === 'activating' || state === 'reloading' ? 'bg-amber-500' : 'bg-muted-foreground/40'

const pending = ref<{ service: string; action: 'restart' | 'stop' | 'start' } | null>(null)
const pendingOpen = computed({ get: () => !!pending.value, set: (v) => { if (!v) pending.value = null } })
async function act() {
  const p = pending.value!
  await post(`/api/server/services/${encodeURIComponent(p.service)}/${p.action}`)
  toast.success(t('{s}: done', { s: p.service }))
  await reload()
}
</script>

<template>
  <div>
    <h2 class="text-2xl font-semibold tracking-tight">{{ t('Server') }}</h2>
    <p class="text-muted-foreground mt-1 text-sm">{{ t('The machine Webcpl runs on, and the services it manages.') }}</p>
  </div>
  <Tabs :model-value="tab" @update:model-value="goTab">
    <TabsList>
      <TabsTrigger value="overview" class="px-3">{{ t('Overview') }}</TabsTrigger>
      <TabsTrigger value="firewall" class="px-3">{{ t('Firewall') }}</TabsTrigger>
      <TabsTrigger value="security" class="px-3">{{ t('Blocked addresses') }}</TabsTrigger>
      <TabsTrigger value="updates" class="px-3">{{ t('Updates') }}</TabsTrigger>
    </TabsList>
  </Tabs>
  <FirewallTab v-if="tab === 'firewall'" />
  <Fail2banTab v-else-if="tab === 'security'" />
  <UpdatesTab v-else-if="tab === 'updates'" />
  <template v-else>
  <LoadError :message="error || agentError" />
  <MetricsCard />

  <div v-if="info" class="grid gap-5 md:grid-cols-2">
    <Card>
      <CardHeader><CardTitle class="flex items-center gap-2"><CpuIcon class="size-4" /> {{ t('System') }}</CardTitle></CardHeader>
      <CardContent>
        <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt class="text-muted-foreground">{{ t('Hostname') }}</dt><dd class="font-mono">{{ info.hostname }}</dd>
          <dt class="text-muted-foreground">{{ t('System') }}</dt><dd>{{ info.os }} ({{ info.arch }})</dd>
          <dt class="text-muted-foreground">{{ t('Kernel') }}</dt><dd class="font-mono">{{ info.kernel }}</dd>
          <dt class="text-muted-foreground">{{ t('Uptime') }}</dt><dd>{{ duration(info.uptime) }}</dd>
          <dt class="text-muted-foreground">{{ t('Processor') }}</dt><dd>{{ info.cpu.count }} × {{ info.cpu.model }}</dd>
          <dt class="text-muted-foreground">{{ t('Load') }}</dt><dd class="font-mono">{{ info.cpu.load.map((n) => n.toFixed(2)).join(' · ') }}</dd>
          <dt class="text-muted-foreground">{{ t('Memory') }}</dt><dd class="font-mono">{{ bytes(info.memory.total - info.memory.free) }} / {{ bytes(info.memory.total) }}</dd>
          <template v-if="info.disk"><dt class="text-muted-foreground">{{ t('Disk') }}</dt><dd class="font-mono">{{ bytes(info.disk.total - info.disk.free) }} / {{ bytes(info.disk.total) }}</dd></template>
          <dt class="text-muted-foreground">Webcpl</dt><dd class="font-mono">{{ data?.version }}</dd>
        </dl>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle class="flex items-center gap-2"><NetworkIcon class="size-4" /> {{ t('Addresses') }}</CardTitle></CardHeader>
      <CardContent>
        <ul class="flex flex-col gap-1.5 text-sm">
          <li v-for="a in info.addresses" :key="a.address" class="flex items-center justify-between gap-3">
            <span class="font-mono break-all">{{ a.address }}</span>
            <span class="text-muted-foreground text-xs">IPv{{ a.family }} · {{ a.interface }}</span>
          </li>
        </ul>
      </CardContent>
    </Card>
  </div>
  <Skeleton v-else-if="!error && !agentError" class="h-48 rounded-xl" />

  <Card v-if="data?.components" class="gap-0 pb-0">
    <CardHeader class="pb-4">
      <CardTitle class="flex items-center gap-2"><PackageIcon class="size-4" /> {{ t('Installed components') }}</CardTitle>
      <CardDescription>{{ t('Chosen when Webcpl was installed.') }}</CardDescription>
    </CardHeader>
    <CardContent class="border-t px-0">
      <Table>
        <TableHeader>
          <TableRow><TableHead class="pl-4">{{ t('Component') }}</TableHead><TableHead>{{ t('Services') }}</TableHead><TableHead class="w-28 pr-4 text-right">{{ t('Actions') }}</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          <template v-for="c in installed" :key="c.id">
            <TableRow v-for="(s, i) in c.services.length ? c.services : [null]" :key="`${c.id}-${s?.name ?? 'none'}`">
              <TableCell v-if="i === 0" :rowspan="Math.max(1, c.services.length)" class="pl-4 align-top">
                <p class="font-medium">{{ c.label }} <Badge v-if="c.upcoming" variant="outline" class="ml-1 text-[10px]">{{ t('set up in a later version') }}</Badge></p>
                <p class="text-muted-foreground text-xs">{{ t(c.description) }}</p>
              </TableCell>
              <TableCell>
                <span v-if="s" class="inline-flex items-center gap-2 font-mono text-sm"><span class="size-2 rounded-full" :class="tone(s.state)" />{{ s.name }} <span class="text-muted-foreground text-xs">{{ s.state }}</span></span>
                <span v-else class="text-muted-foreground text-sm">—</span>
              </TableCell>
              <TableCell class="pr-4 text-right">
                <Button v-if="s && s.state === 'active'" variant="ghost" size="icon-sm" :aria-label="t('Restart {s}', { s: s.name })" @click="pending = { service: s.name, action: 'restart' }"><RotateCwIcon /></Button>
                <Button v-else-if="s" variant="outline" size="sm" @click="pending = { service: s.name, action: 'start' }">{{ t('Start') }}</Button>
              </TableCell>
            </TableRow>
          </template>
        </TableBody>
      </Table>
      <p v-if="available.length" class="text-muted-foreground border-t px-4 py-3 text-xs">
        {{ t('Not installed') }}: {{ available.map((c) => c.label).join(', ') }}
      </p>
    </CardContent>
  </Card>

  </template>

  <ConfirmDialog
    v-model:open="pendingOpen"
    :title="pending?.action === 'restart' ? t('Restart {s}?', { s: pending?.service ?? '' }) : t('Start {s}?', { s: pending?.service ?? '' })"
    :description="pending?.action === 'restart' ? t('The service goes down for a moment. Sites using it may answer with an error during that time.') : t('The service starts now.')"
    :action="pending?.action === 'restart' ? t('Restart') : t('Start')"
    :confirm="act"
  />
</template>
