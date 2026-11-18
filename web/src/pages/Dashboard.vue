<script setup lang="ts">
import { BanIcon, BoxIcon, ClockIcon, DatabaseIcon, FolderIcon, GlobeIcon, KeyRoundIcon, LayersIcon, ServerIcon, UserCogIcon, UsersIcon } from '@lucide/vue'
import { computed } from 'vue'
import LimitsSummary from '@/components/app/LimitsSummary.vue'
import UsageBars from '@/components/app/UsageBars.vue'
import LoadError from '@/components/LoadError.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { useResource } from '@/composables/useResource'
import { panelName, user } from '@/composables/useSession'
import { bytes, duration } from '@/lib/format'
import { t } from '@/lib/i18n'
import type { ResellerUsage, ServerInfo } from '@/lib/types'

const role = computed(() => user.value?.role)
const HOSTING_LINKS = [
  { to: '/websites', label: 'Websites', icon: GlobeIcon },
  { to: '/files', label: 'Files', icon: FolderIcon },
  { to: '/databases', label: 'Databases', icon: DatabaseIcon },
  { to: '/cron', label: 'Cron jobs', icon: ClockIcon },
  { to: '/access', label: 'Access and PHP', icon: KeyRoundIcon },
]
const { data, error } = useResource<{ counts?: Record<string, number>; usage?: ResellerUsage }>('/api/dashboard', 30_000)
const server = role.value === 'admin' ? useResource<{ info: ServerInfo | { error: string } }>('/api/server', 30_000) : null
const info = computed(() => {
  const value = server?.data.value?.info
  return value && !('error' in value) ? value : null
})
const agentError = computed(() => {
  const value = server?.data.value?.info
  return value && 'error' in value ? value.error : ''
})
const mainIp = computed(() => info.value?.addresses.find((a) => a.family === 4)?.address ?? info.value?.addresses[0]?.address ?? '')

const tiles = computed(() => {
  const c = data.value?.counts ?? {}
  return role.value === 'admin'
    ? [
        { label: 'Resellers', value: c.resellers, icon: UserCogIcon, to: '/accounts' },
        { label: 'Users', value: c.users, icon: UsersIcon, to: '/accounts' },
        { label: 'Suspended', value: c.suspended, icon: BanIcon, to: '/accounts' },
        { label: 'Plans', value: c.plans, icon: LayersIcon, to: '/plans' },
      ]
    : [
        { label: 'Accounts', value: c.users, icon: UsersIcon, to: '/accounts' },
        { label: 'Suspended', value: c.suspended, icon: BanIcon, to: '/accounts' },
        { label: 'Plans', value: c.plans, icon: LayersIcon, to: '/plans' },
      ]
})
</script>

<template>
  <div>
    <h2 class="text-2xl font-semibold tracking-tight">{{ t('Hello, {u}', { u: user?.username ?? '' }) }}</h2>
    <p class="text-muted-foreground mt-1 text-sm">{{ t('Welcome to {p}.', { p: panelName }) }}</p>
  </div>
  <LoadError :message="error || agentError" />

  <!-- Admin and reseller: what they manage at a glance. -->
  <template v-if="role === 'admin' || role === 'reseller'">
    <div class="grid gap-3 sm:grid-cols-2" :class="role === 'admin' ? 'xl:grid-cols-4' : 'xl:grid-cols-3'">
      <RouterLink v-for="tile in tiles" :key="tile.label" :to="tile.to">
        <Card class="hover:bg-muted/40 gap-2 transition-colors">
          <CardHeader><CardDescription class="flex items-center gap-2"><component :is="tile.icon" class="size-4" /> {{ t(tile.label) }}</CardDescription></CardHeader>
          <CardContent>
            <div class="text-3xl font-semibold tabular-nums">{{ tile.value ?? '—' }}</div>
          </CardContent>
        </Card>
      </RouterLink>
    </div>
  </template>

  <Card v-if="role === 'admin'">
    <CardHeader>
      <CardTitle class="flex items-center gap-2"><ServerIcon class="size-4" /> {{ t('This server') }}</CardTitle>
      <CardDescription v-if="info">{{ info.hostname }} · {{ info.os }} · {{ t('up {d}', { d: duration(info.uptime) }) }}</CardDescription>
      <CardAction><Button variant="outline" size="sm" as-child><RouterLink to="/server">{{ t('Server and services') }}</RouterLink></Button></CardAction>
    </CardHeader>
    <CardContent v-if="info" class="grid gap-6 md:grid-cols-3">
      <div class="flex flex-col gap-1.5">
        <div class="flex justify-between text-sm"><span class="text-muted-foreground">{{ t('CPU load') }}</span><span class="font-mono">{{ info.cpu.load[0]?.toFixed(2) }} / {{ info.cpu.count }}</span></div>
        <Progress :model-value="Math.min(100, ((info.cpu.load[0] ?? 0) / info.cpu.count) * 100)" class="h-1.5" />
      </div>
      <div class="flex flex-col gap-1.5">
        <div class="flex justify-between text-sm"><span class="text-muted-foreground">{{ t('Memory') }}</span><span class="font-mono">{{ bytes(info.memory.total - info.memory.free) }} / {{ bytes(info.memory.total) }}</span></div>
        <Progress :model-value="((info.memory.total - info.memory.free) / info.memory.total) * 100" class="h-1.5" />
      </div>
      <div v-if="info.disk" class="flex flex-col gap-1.5">
        <div class="flex justify-between text-sm"><span class="text-muted-foreground">{{ t('Disk') }}</span><span class="font-mono">{{ bytes(info.disk.total - info.disk.free) }} / {{ bytes(info.disk.total) }}</span></div>
        <Progress :model-value="((info.disk.total - info.disk.free) / info.disk.total) * 100" class="h-1.5" />
      </div>
      <p v-if="mainIp" class="text-muted-foreground text-sm md:col-span-3">
        {{ t('Main address') }}: <span class="text-foreground font-mono">{{ mainIp }}</span>
      </p>
    </CardContent>
    <CardContent v-else-if="!agentError"><Skeleton class="h-16" /></CardContent>
  </Card>

  <Card v-if="role === 'reseller' && data?.usage">
    <CardHeader>
      <CardTitle>{{ t('Your reseller plan') }}</CardTitle>
      <CardDescription>{{ t('What your accounts may use in total. Ask your provider for more.') }}</CardDescription>
    </CardHeader>
    <CardContent><UsageBars :usage="data.usage" /></CardContent>
  </Card>

  <!-- Every level with a plan of its own sees it. -->
  <div v-if="user?.hostingPlan || user?.vpsPlan" class="grid gap-4 md:grid-cols-2">
    <Card v-if="user?.hostingPlan">
      <CardHeader>
        <CardTitle class="flex items-center gap-2"><GlobeIcon class="size-4" /> {{ t('Hosting') }}: {{ user.hostingPlan.name }}</CardTitle>
        <CardDescription>{{ t('Websites, databases, mail and files.') }}</CardDescription>
      </CardHeader>
      <CardContent><LimitsSummary kind="hosting" :limits="user.hostingPlan.limits" /></CardContent>
    </Card>
    <Card v-if="user?.vpsPlan">
      <CardHeader>
        <CardTitle class="flex items-center gap-2"><BoxIcon class="size-4" /> {{ t('VPS') }}: {{ user.vpsPlan.name }}</CardTitle>
        <CardDescription>{{ t('Your own Linux system with root access.') }}</CardDescription>
      </CardHeader>
      <CardContent><LimitsSummary kind="vps" :limits="user.vpsPlan.limits" /></CardContent>
    </Card>
  </div>
  <div v-if="user?.hostingPlan" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
    <RouterLink v-for="link in HOSTING_LINKS" :key="link.to" :to="link.to">
      <Card class="hover:bg-muted/40 h-full gap-1 py-4 transition-colors">
        <CardContent class="flex items-center gap-3 px-4">
          <component :is="link.icon" class="text-muted-foreground size-5" />
          <span class="text-sm font-medium">{{ t(link.label) }}</span>
        </CardContent>
      </Card>
    </RouterLink>
  </div>
  <Skeleton v-if="!data && !error" class="h-32 rounded-xl" />
</template>
