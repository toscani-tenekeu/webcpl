<script setup lang="ts">
import { BoxIcon, DicesIcon, PlusIcon } from '@lucide/vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import VpsStatus from '@/components/app/VpsStatus.vue'
import LoadError from '@/components/LoadError.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { useResource } from '@/composables/useResource'
import { user } from '@/composables/useSession'
import { messageOf, post } from '@/lib/api'
import { t } from '@/lib/i18n'
import { randomPassword } from '@/lib/password'
import type { Vps, VpsImageInfo, VpsRoom } from '@/lib/types'

const router = useRouter()
const own = user.value?.vpsPlan ? useResource<{ vps: Vps[]; room: VpsRoom; limits: Record<string, number | null>; images: VpsImageInfo[] }>('/api/vps', 8000) : null
const managed = user.value?.role !== 'user' ? useResource<{ vps: Vps[] }>('/api/vps?all=1', 15000) : null

const bars = computed(() => {
  const d = own?.data.value
  if (!d) return []
  return [
    { label: 'vCPU', used: d.room.used.vcpu, total: d.limits.vcpu, unit: '' },
    { label: 'Memory', used: d.room.used.memory_mb, total: d.limits.memory_mb, unit: ' MB' },
    { label: 'Disk', used: d.room.used.disk_gb, total: d.limits.disk_gb, unit: ' GB' },
  ]
})

// ---- create ----
const creating = ref(false)
const form = ref({ name: '', image: '', vcpu: 1, memoryMb: 1024, diskGb: 10, password: '', sshKey: '' })
const busy = ref(false)
const formError = ref('')
function openCreate() {
  const d = own!.data.value!
  const left = d.room.left
  form.value = {
    name: '',
    image: d.images[0]?.id ?? '',
    vcpu: Math.max(1, Math.min(left.vcpu ?? 1, 1)),
    memoryMb: Math.max(256, Math.min(left.memory_mb ?? 1024, 1024)),
    diskGb: Math.max(2, Math.min(left.disk_gb ?? 10, 10)),
    password: randomPassword(16),
    sshKey: '',
  }
  formError.value = ''
  creating.value = true
}
async function create() {
  busy.value = true
  formError.value = ''
  try {
    const r = await post<{ vps: Vps }>('/api/vps', form.value)
    creating.value = false
    toast.success(t('{n} is being created. Keep the root password: {p}', { n: r.vps.name, p: form.value.password }), { duration: 20000 })
    await router.push(`/vps/${r.vps.id}`)
  } catch (failure) {
    formError.value = messageOf(failure)
  }
  busy.value = false
}
const full = computed(() => {
  const left = own?.data.value?.room.left
  return !!left && ((left.vcpu ?? 1) < 1 || (left.memory_mb ?? 256) < 256 || (left.disk_gb ?? 2) < 2)
})
onBeforeUnmount(() => (creating.value = false))
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">VPS</h2>
      <p class="text-muted-foreground mt-1 text-sm">{{ t('Linux servers of your own, with root access, in LXC containers.') }}</p>
    </div>
    <Button v-if="own?.data.value" :disabled="full" @click="openCreate"><PlusIcon data-icon="inline-start" /> {{ t('New VPS') }}</Button>
  </div>

  <template v-if="own">
    <LoadError :message="own.data.value ? '' : own.error.value" />
    <Card v-if="own.data.value">
      <CardHeader><CardTitle>{{ t('Your VPS plan') }}</CardTitle><CardDescription>{{ t('Split it across as many VPS as you like.') }}</CardDescription></CardHeader>
      <CardContent class="grid gap-5 sm:grid-cols-3">
        <div v-for="b in bars" :key="b.label" class="flex flex-col gap-1.5">
          <div class="flex justify-between text-sm"><span class="text-muted-foreground">{{ t(b.label) }}</span><span class="font-mono">{{ b.used }}{{ b.unit }} / {{ b.total ?? '∞' }}{{ b.total ? b.unit : '' }}</span></div>
          <Progress :model-value="b.total ? Math.min(100, (b.used / b.total) * 100) : 0" class="h-1.5" />
        </div>
      </CardContent>
    </Card>
    <Card v-if="own.data.value?.vps.length" class="py-0">
      <CardContent class="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="pl-4">{{ t('Name') }}</TableHead><TableHead>{{ t('Status') }}</TableHead><TableHead>{{ t('System') }}</TableHead>
              <TableHead class="hidden md:table-cell">{{ t('Resources') }}</TableHead><TableHead class="pr-4">SSH</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="v in own.data.value.vps" :key="v.id" class="cursor-pointer" @click="router.push(`/vps/${v.id}`)">
              <TableCell class="pl-4 font-mono font-medium">{{ v.name }}</TableCell>
              <TableCell><VpsStatus :vps="v" /></TableCell>
              <TableCell>{{ v.image.name }} {{ v.image.version }}</TableCell>
              <TableCell class="text-muted-foreground hidden font-mono text-xs md:table-cell">{{ v.vcpu }} vCPU · {{ v.memoryMb }} MB · {{ v.diskGb }} GB</TableCell>
              <TableCell class="pr-4 font-mono text-xs">:{{ v.sshPort }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
    <Card v-else-if="own.data.value">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><BoxIcon /></EmptyMedia>
          <EmptyTitle>{{ t('No VPS yet') }}</EmptyTitle>
          <EmptyDescription>{{ t('Pick an operating system; it is ready in about a minute.') }}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent><Button @click="openCreate"><PlusIcon data-icon="inline-start" /> {{ t('New VPS') }}</Button></EmptyContent>
      </Empty>
    </Card>
    <Skeleton v-else-if="!own.error.value" class="h-48 rounded-xl" />
  </template>

  <template v-if="managed">
    <h3 v-if="own" class="mt-2 text-lg font-semibold">{{ t('Your customers’ VPS') }}</h3>
    <LoadError :message="managed.data.value ? '' : managed.error.value" />
    <Card v-if="managed.data.value" class="py-0">
      <CardContent class="px-0">
        <p v-if="!managed.data.value.vps.length" class="text-muted-foreground p-6 text-sm">{{ t('No customer has created a VPS yet.') }}</p>
        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead class="pl-4">{{ t('Name') }}</TableHead><TableHead>{{ t('Account') }}</TableHead><TableHead>{{ t('Status') }}</TableHead>
              <TableHead>{{ t('System') }}</TableHead><TableHead class="hidden md:table-cell">{{ t('Resources') }}</TableHead><TableHead class="pr-4">{{ t('Address') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="v in managed.data.value.vps" :key="v.id" class="cursor-pointer" @click="router.push(`/vps/${v.id}`)">
              <TableCell class="pl-4 font-mono font-medium">{{ v.name }}</TableCell>
              <TableCell>{{ v.owner }}</TableCell>
              <TableCell><VpsStatus :vps="v" /></TableCell>
              <TableCell>{{ v.image.name }} {{ v.image.version }}</TableCell>
              <TableCell class="text-muted-foreground hidden font-mono text-xs md:table-cell">{{ v.vcpu }} vCPU · {{ v.memoryMb }} MB · {{ v.diskGb }} GB</TableCell>
              <TableCell class="pr-4 font-mono text-xs">{{ v.ipv4 ?? '—' }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
    <Skeleton v-else-if="!managed.error.value" class="h-32 rounded-xl" />
  </template>

  <Dialog v-model:open="creating">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ t('New VPS') }}</DialogTitle>
        <DialogDescription>{{ t('Resources come out of your VPS plan; you can change them later.') }}</DialogDescription>
      </DialogHeader>
      <form v-if="own?.data.value" id="new-vps" class="flex flex-col gap-4" @submit.prevent="create">
        <div class="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel for="vps-name">{{ t('Name') }}</FieldLabel>
            <Input id="vps-name" v-model="form.name" class="font-mono" placeholder="web1" autocomplete="off" />
          </Field>
          <Field>
            <FieldLabel>{{ t('Operating system') }}</FieldLabel>
            <Select v-model="form.image">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem v-for="i in own.data.value.images" :key="i.id" :value="i.id">{{ i.name }} {{ i.version }}</SelectItem></SelectContent>
            </Select>
          </Field>
        </div>
        <div class="grid grid-cols-3 gap-3">
          <Field>
            <FieldLabel for="vps-cpu">vCPU</FieldLabel>
            <Input id="vps-cpu" v-model.number="form.vcpu" type="number" min="1" :max="own.data.value.room.left.vcpu ?? undefined" />
          </Field>
          <Field>
            <FieldLabel for="vps-mem">{{ t('Memory (MB)') }}</FieldLabel>
            <Input id="vps-mem" v-model.number="form.memoryMb" type="number" min="256" step="128" :max="own.data.value.room.left.memory_mb ?? undefined" />
          </Field>
          <Field>
            <FieldLabel for="vps-disk">{{ t('Disk (GB)') }}</FieldLabel>
            <Input id="vps-disk" v-model.number="form.diskGb" type="number" min="2" :max="own.data.value.room.left.disk_gb ?? undefined" />
          </Field>
        </div>
        <FieldDescription>
          {{ t('Left in your plan: {c} vCPU, {m} MB, {d} GB.', { c: own.data.value.room.left.vcpu ?? '∞', m: own.data.value.room.left.memory_mb ?? '∞', d: own.data.value.room.left.disk_gb ?? '∞' }) }}
        </FieldDescription>
        <Field>
          <FieldLabel for="vps-pass">{{ t('Root password') }}</FieldLabel>
          <InputGroup>
            <InputGroupInput id="vps-pass" v-model="form.password" class="font-mono" autocomplete="new-password" />
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" :aria-label="t('Generate')" @click="form.password = randomPassword(16)"><DicesIcon /></InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </Field>
        <Field>
          <FieldLabel for="vps-key">{{ t('SSH public key (optional)') }}</FieldLabel>
          <Textarea id="vps-key" v-model="form.sshKey" class="h-16 font-mono text-xs" placeholder="ssh-ed25519 AAAA…" />
        </Field>
        <FieldError v-if="formError">{{ formError }}</FieldError>
      </form>
      <DialogFooter>
        <Button variant="outline" @click="creating = false">{{ t('Cancel') }}</Button>
        <Button type="submit" form="new-vps" :disabled="busy || !form.name"><Spinner v-if="busy" data-icon="inline-start" /> {{ t('Create') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
