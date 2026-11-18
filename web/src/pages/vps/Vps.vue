<script setup lang="ts">
import { CameraIcon, ChevronRightIcon, DicesIcon, HistoryIcon, PlayIcon, PowerIcon, RotateCwIcon, SaveIcon, SquareIcon, Trash2Icon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import ConfirmDialog from '@/components/app/ConfirmDialog.vue'
import CopyLine from '@/components/app/CopyLine.vue'
import VpsConsole from '@/components/app/VpsConsole.vue'
import VpsStatus from '@/components/app/VpsStatus.vue'
import LoadError from '@/components/LoadError.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useResource } from '@/composables/useResource'
import { api, del, messageOf, post } from '@/lib/api'
import { bytes, date } from '@/lib/format'
import { t } from '@/lib/i18n'
import { randomPassword } from '@/lib/password'
import type { Vps, VpsImageInfo, VpsRoom } from '@/lib/types'

const route = useRoute()
const router = useRouter()
const id = computed(() => Number(route.params.id))
const tab = computed(() => String(route.params.tab || 'overview'))
const { data, error, reload } = useResource<{ vps: Vps; owner: string; limits: Record<string, number | null>; room: VpsRoom; images: VpsImageInfo[] }>(
  () => `/api/vps/${id.value}`, 5000)
const vps = computed(() => data.value?.vps)
const host = location.hostname
const goTab = (value: string | number) => router.replace(value === 'overview' ? `/vps/${id.value}` : `/vps/${id.value}/${value}`)

// ---- power ----
const powering = ref('')
async function power(action: string) {
  powering.value = action
  try {
    await post(`/api/vps/${id.value}/power`, { action })
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  powering.value = ''
}

// ---- public addresses ----
const ipBusy = ref(false)
async function addIp() {
  ipBusy.value = true
  try {
    const r = await post<{ ip: string }>(`/api/vps/${id.value}/ips`)
    toast.success(t('{ip} is now on this VPS. It restarted to use it.', { ip: r.ip }))
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  ipBusy.value = false
}
async function releaseIp(ip: string) {
  ipBusy.value = true
  try {
    await del(`/api/vps/${id.value}/ips/${ip}`)
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  ipBusy.value = false
}

// ---- snapshots ----
const snaps = ref<{ snapshots: { name: string; createdAt: number }[]; limit: number | null } | null>(null)
const snapName = ref('')
const snapBusy = ref('')
async function loadSnaps() {
  try {
    snaps.value = await api(`/api/vps/${id.value}/snapshots`)
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}
watch([tab, () => vps.value?.status], () => { if (tab.value === 'snapshots' && vps.value?.status === 'ready') void loadSnaps() }, { immediate: true })
async function snapAction(kind: 'create' | 'restore' | 'delete', name = '') {
  snapBusy.value = kind + name
  try {
    if (kind === 'create') await post(`/api/vps/${id.value}/snapshots`, { name: snapName.value })
    else if (kind === 'restore') await post(`/api/vps/${id.value}/snapshots/${encodeURIComponent(name)}/restore`)
    else await del(`/api/vps/${id.value}/snapshots/${encodeURIComponent(name)}`)
    toast.success(kind === 'create' ? t('Snapshot taken') : kind === 'restore' ? t('Snapshot restored') : t('Snapshot deleted'))
    snapName.value = ''
    await loadSnaps()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  snapBusy.value = ''
}
const restoring = ref('')
const restoreOpen = computed({ get: () => !!restoring.value, set: (v) => { if (!v) restoring.value = '' } })

// ---- settings ----
const size = ref({ vcpu: 1, memoryMb: 1024, diskGb: 10 })
watch(vps, (v, old) => { if (v && v.id !== old?.id) size.value = { vcpu: v.vcpu, memoryMb: v.memoryMb, diskGb: v.diskGb } }, { immediate: true })
const max = computed(() => {
  const left = data.value?.room.left
  return { vcpu: left?.vcpu ?? null, memory_mb: left?.memory_mb ?? null, disk_gb: left?.disk_gb ?? null }
})
const resizing = ref(false)
async function resize() {
  resizing.value = true
  try {
    await post(`/api/vps/${id.value}/resize`, size.value)
    toast.success(t('Resources changed'))
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  resizing.value = false
}
const rootPassword = ref('')
async function changePassword() {
  try {
    await post(`/api/vps/${id.value}/password`, { password: rootPassword.value })
    toast.success(t('Root password changed'))
    rootPassword.value = ''
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}
const re = ref({ image: '', password: '', sshKey: '' })
const reinstallOpen = ref(false)
function openReinstall() {
  re.value = { image: vps.value!.image.id, password: randomPassword(16), sshKey: '' }
  reinstallOpen.value = true
}
async function reinstall() {
  await post(`/api/vps/${id.value}/reinstall`, { ...re.value, confirm: vps.value!.name })
  toast.success(t('Reinstalling. The new root password is {p}', { p: re.value.password }), { duration: 20000 })
  await reload()
  await goTab('overview')
}
const removeOpen = ref(false)
async function remove() {
  await api(`/api/vps/${id.value}`, { method: 'DELETE', body: { confirm: vps.value!.name } })
  toast.success(t('{d} deleted', { d: vps.value!.name }))
  await router.push('/vps')
}
const running = computed(() => vps.value?.status === 'ready' && vps.value.state === 'running')
</script>

<template>
  <LoadError :message="data ? '' : error" />
  <template v-if="vps && data">
    <nav class="text-muted-foreground flex items-center gap-1 text-sm">
      <RouterLink to="/vps" class="hover:text-foreground">VPS</RouterLink>
      <ChevronRightIcon class="size-3.5" />
      <span class="text-foreground font-mono">{{ vps.name }}</span>
    </nav>
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="flex items-center gap-3 font-mono text-2xl font-semibold tracking-tight">{{ vps.name }} <VpsStatus :vps="vps" class="font-sans" /></h2>
        <p class="text-muted-foreground mt-1 text-sm">{{ vps.image.name }} {{ vps.image.version }} · {{ vps.vcpu }} vCPU · {{ vps.memoryMb }} MB · {{ vps.diskGb }} GB<template v-if="data.owner"> · {{ data.owner }}</template></p>
      </div>
      <div v-if="vps.status === 'ready'" class="flex gap-2">
        <Button v-if="vps.state !== 'running'" :disabled="!!powering" @click="power('start')"><Spinner v-if="powering === 'start'" data-icon="inline-start" /><PlayIcon v-else data-icon="inline-start" /> {{ t('Start') }}</Button>
        <template v-else>
          <Button variant="outline" :disabled="!!powering" @click="power('restart')"><Spinner v-if="powering === 'restart'" data-icon="inline-start" /><RotateCwIcon v-else data-icon="inline-start" /> {{ t('Restart') }}</Button>
          <Button variant="outline" :disabled="!!powering" @click="power('stop')"><Spinner v-if="powering === 'stop'" data-icon="inline-start" /><SquareIcon v-else data-icon="inline-start" /> {{ t('Stop') }}</Button>
        </template>
      </div>
    </div>

    <Alert v-if="vps.status === 'error'" variant="destructive">
      <AlertTitle>{{ t('The VPS could not be set up') }}</AlertTitle>
      <AlertDescription>{{ vps.error }} {{ t('Reinstall it from Settings, or delete it.') }}</AlertDescription>
    </Alert>
    <Alert v-if="vps.throttled">
      <AlertTitle>{{ t('Monthly traffic used up') }}</AlertTitle>
      <AlertDescription>{{ t('The network is slowed to 1 Mbit/s until the start of next month.') }}</AlertDescription>
    </Alert>

    <Tabs :model-value="tab" @update:model-value="goTab">
      <TabsList>
        <TabsTrigger value="overview" class="px-3">{{ t('Overview') }}</TabsTrigger>
        <TabsTrigger value="console" class="px-3" :disabled="!running">{{ t('Console') }}</TabsTrigger>
        <TabsTrigger value="snapshots" class="px-3">{{ t('Snapshots') }}</TabsTrigger>
        <TabsTrigger value="settings" class="px-3">{{ t('Settings') }}</TabsTrigger>
      </TabsList>
    </Tabs>

    <template v-if="tab === 'overview'">
      <div class="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{{ t('Connect') }}</CardTitle><CardDescription>{{ t('Sign in as root with the password you chose, or your SSH key.') }}</CardDescription></CardHeader>
          <CardContent class="flex flex-col gap-3">
            <CopyLine :text="`ssh -p ${vps.sshPort} root@${host}`" />
            <p class="text-muted-foreground text-xs">{{ t('Private address') }}: <span class="text-foreground font-mono">{{ vps.ipv4 ?? '—' }}</span><template v-if="vps.ipv6"> · <span class="text-foreground font-mono">{{ vps.ipv6 }}</span></template></p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{{ t('Public addresses') }}</CardTitle>
            <CardDescription>{{ t('A public IPv4 address reaches the VPS directly, on every port. Your plan includes {n}.', { n: data.limits.ipv4 ?? '∞' }) }}</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-3">
            <ul v-if="vps.publicIps.length" class="flex flex-col gap-2">
              <li v-for="ip in vps.publicIps" :key="ip" class="flex items-center justify-between gap-2">
                <CopyLine :text="ip" class="flex-1" />
                <Button size="sm" variant="outline" :disabled="ipBusy" @click="releaseIp(ip)">{{ t('Release') }}</Button>
              </li>
            </ul>
            <div><Button variant="outline" :disabled="ipBusy || vps.status !== 'ready'" @click="addIp"><Spinner v-if="ipBusy" data-icon="inline-start" /> {{ t('Add a public IPv4') }}</Button></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{{ t('Usage') }}</CardTitle></CardHeader>
          <CardContent class="flex flex-col gap-4">
            <div class="flex flex-col gap-1.5">
              <div class="flex justify-between text-sm"><span class="text-muted-foreground">{{ t('Memory') }}</span><span class="font-mono">{{ bytes(vps.memoryBytes) }} / {{ vps.memoryMb }} MB</span></div>
              <Progress :model-value="vps.memoryBytes ? Math.min(100, (vps.memoryBytes / (vps.memoryMb * 1048576)) * 100) : 0" class="h-1.5" />
            </div>
            <div class="flex flex-col gap-1.5">
              <div class="flex justify-between text-sm"><span class="text-muted-foreground">{{ t('Traffic this month') }}</span><span class="font-mono">{{ bytes(vps.trafficBytes) }} / {{ data.limits.traffic_gb ? `${data.limits.traffic_gb} GB` : '∞' }}</span></div>
              <Progress :model-value="data.limits.traffic_gb ? Math.min(100, (vps.trafficBytes / (data.limits.traffic_gb * 1e9)) * 100) : 0" class="h-1.5" />
            </div>
            <p class="text-muted-foreground text-xs">{{ t('Created {d}', { d: date(vps.createdAt) }) }}</p>
          </CardContent>
        </Card>
      </div>
    </template>

    <VpsConsole v-else-if="tab === 'console' && running" :id="vps.id" />
    <Card v-else-if="tab === 'console'"><CardContent class="text-muted-foreground text-sm">{{ t('Start the VPS to open a console.') }}</CardContent></Card>

    <Card v-else-if="tab === 'snapshots'" class="gap-0 pb-0">
      <CardHeader class="pb-4">
        <CardTitle>{{ t('Snapshots') }}</CardTitle>
        <CardDescription>{{ t('A copy of the whole system you can go back to. {n} allowed by your plan.', { n: snaps?.limit ?? '∞' }) }}</CardDescription>
        <CardAction>
          <form class="flex gap-2" @submit.prevent="snapAction('create')">
            <Input v-model="snapName" class="w-40 font-mono" :placeholder="t('optional name')" />
            <Button type="submit" :disabled="!!snapBusy || vps.status !== 'ready'"><Spinner v-if="snapBusy === 'create'" data-icon="inline-start" /><CameraIcon v-else data-icon="inline-start" /> {{ t('Take') }}</Button>
          </form>
        </CardAction>
      </CardHeader>
      <CardContent class="border-t px-0">
        <Skeleton v-if="!snaps && vps.status === 'ready'" class="m-4 h-16" />
        <p v-else-if="!snaps?.snapshots.length" class="text-muted-foreground p-4 text-sm">{{ t('No snapshots yet.') }}</p>
        <Table v-else>
          <TableBody>
            <TableRow v-for="s in snaps.snapshots" :key="s.name">
              <TableCell class="pl-4 font-mono">{{ s.name }}</TableCell>
              <TableCell class="text-muted-foreground text-sm">{{ date(s.createdAt) }}</TableCell>
              <TableCell class="pr-4">
                <div class="flex justify-end gap-1">
                  <Button size="sm" variant="outline" :disabled="!!snapBusy" @click="restoring = s.name"><HistoryIcon data-icon="inline-start" /> {{ t('Restore') }}</Button>
                  <Button size="icon-sm" variant="ghost" class="text-destructive" :disabled="!!snapBusy" :aria-label="t('Delete')" @click="snapAction('delete', s.name)">
                    <Spinner v-if="snapBusy === 'delete' + s.name" /><Trash2Icon v-else />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <template v-else-if="tab === 'settings'">
      <Card>
        <CardHeader><CardTitle>{{ t('Resources') }}</CardTitle><CardDescription>{{ t('Left in your plan besides this VPS: {c} vCPU, {m} MB, {d} GB. The disk can only grow.', { c: max.vcpu ?? '∞', m: max.memory_mb ?? '∞', d: max.disk_gb ?? '∞' }) }}</CardDescription></CardHeader>
        <CardContent>
          <form class="flex flex-wrap items-end gap-3" @submit.prevent="resize">
            <Field class="w-28"><FieldLabel for="r-cpu">vCPU</FieldLabel><Input id="r-cpu" v-model.number="size.vcpu" type="number" min="1" /></Field>
            <Field class="w-36"><FieldLabel for="r-mem">{{ t('Memory (MB)') }}</FieldLabel><Input id="r-mem" v-model.number="size.memoryMb" type="number" min="256" step="128" /></Field>
            <Field class="w-32"><FieldLabel for="r-disk">{{ t('Disk (GB)') }}</FieldLabel><Input id="r-disk" v-model.number="size.diskGb" type="number" :min="vps.diskGb" /></Field>
            <Button type="submit" :disabled="resizing || vps.status !== 'ready'"><Spinner v-if="resizing" data-icon="inline-start" /><SaveIcon v-else data-icon="inline-start" /> {{ t('Apply') }}</Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{{ t('Root password') }}</CardTitle><CardDescription>{{ t('Sets a new password for root inside the VPS.') }}</CardDescription></CardHeader>
        <CardContent>
          <form class="flex flex-wrap gap-2" @submit.prevent="changePassword">
            <InputGroup class="w-72">
              <InputGroupInput v-model="rootPassword" class="font-mono" autocomplete="new-password" />
              <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" :aria-label="t('Generate')" @click="rootPassword = randomPassword(16)"><DicesIcon /></InputGroupButton></InputGroupAddon>
            </InputGroup>
            <Button type="submit" :disabled="rootPassword.length < 10 || !running">{{ t('Change') }}</Button>
          </form>
        </CardContent>
      </Card>
      <Card class="border-destructive/30">
        <CardHeader>
          <CardTitle class="flex items-center gap-2"><PowerIcon class="size-4" /> {{ t('Reinstall') }}</CardTitle>
          <CardDescription>{{ t('Erases everything on the VPS and installs a fresh system. Snapshots are kept.') }}</CardDescription>
          <CardAction><Button variant="outline" :disabled="vps.status === 'creating'" @click="openReinstall">{{ t('Reinstall…') }}</Button></CardAction>
        </CardHeader>
        <CardHeader>
          <CardTitle class="flex items-center gap-2"><Trash2Icon class="size-4" /> {{ t('Delete this VPS') }}</CardTitle>
          <CardDescription>{{ t('The VPS, its disk and its snapshots are removed for good.') }}</CardDescription>
          <CardAction><Button variant="destructive" @click="removeOpen = true"><Trash2Icon data-icon="inline-start" /> {{ t('Delete…') }}</Button></CardAction>
        </CardHeader>
      </Card>
    </template>

    <ConfirmDialog v-model:open="restoreOpen" :title="t('Restore {n}?', { n: restoring })" :description="t('The VPS goes back to this snapshot. Changes made since then are lost.')" :action="t('Restore')" destructive :confirm="() => snapAction('restore', restoring)" />
    <ConfirmDialog v-model:open="reinstallOpen" :title="t('Reinstall {n}?', { n: vps.name })" :description="t('Everything on the VPS is erased.')" :word="vps.name" :action="t('Reinstall')" destructive :confirm="reinstall">
      <div class="flex flex-col gap-3">
        <Field>
          <FieldLabel>{{ t('Operating system') }}</FieldLabel>
          <Select v-model="re.image">
            <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem v-for="i in data.images" :key="i.id" :value="i.id">{{ i.name }} {{ i.version }}</SelectItem></SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>{{ t('Root password') }}</FieldLabel>
          <Input v-model="re.password" class="font-mono" />
          <FieldDescription>{{ t('Keep it: it is not shown again.') }}</FieldDescription>
        </Field>
        <Field><FieldLabel>{{ t('SSH public key (optional)') }}</FieldLabel><Textarea v-model="re.sshKey" class="h-14 font-mono text-xs" /></Field>
      </div>
    </ConfirmDialog>
    <ConfirmDialog v-model:open="removeOpen" :title="t('Delete {n}?', { n: vps.name })" :description="t('The VPS, its disk and its snapshots are removed for good.')" :word="vps.name" :action="t('Delete VPS')" destructive :confirm="remove" />
  </template>
  <Skeleton v-else-if="!error" class="h-80 rounded-xl" />
</template>
