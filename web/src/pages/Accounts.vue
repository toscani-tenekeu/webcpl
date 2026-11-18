<script setup lang="ts">
import { SearchIcon, UserPlusIcon, UsersIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import SecretDialog from '@/components/app/SecretDialog.vue'
import LoadError from '@/components/LoadError.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useResource } from '@/composables/useResource'
import { user } from '@/composables/useSession'
import { api, messageOf, post } from '@/lib/api'
import { ago } from '@/lib/format'
import { t } from '@/lib/i18n'
import type { Account, Plan } from '@/lib/types'

const router = useRouter()
const isAdmin = computed(() => user.value?.role === 'admin')
const { data, error, reload } = useResource<{ accounts: Account[] }>('/api/accounts')

const tab = ref<'user' | 'reseller'>('user')
const q = ref('')
const shown = computed(() => {
  const needle = q.value.trim().toLowerCase()
  return (data.value?.accounts ?? [])
    .filter((a) => a.role === tab.value)
    .filter((a) => !needle || [a.username, a.email, a.owner?.username, a.hostingPlan?.name, a.vpsPlan?.name].some((v) => v?.toLowerCase().includes(needle)))
})

// ---- new account ----
const NONE = 'none'
const creating = ref(false)
const plans = ref<Plan[]>([])
const form = ref({ username: '', email: '', password: '', role: 'user' as 'user' | 'reseller', hosting: NONE, vps: NONE, reseller: NONE, mustChange: true, note: '' })
const busy = ref(false)
const formError = ref('')
const created = ref<{ username: string; password: string } | null>(null)
const plansOf = (kind: Plan['kind']) => plans.value.filter((p) => p.kind === kind)

async function openNew() {
  form.value = { username: '', email: '', password: '', role: isAdmin.value ? tab.value : 'user', hosting: NONE, vps: NONE, reseller: NONE, mustChange: true, note: '' }
  formError.value = ''
  creating.value = true
  plans.value = (await api<{ plans: Plan[] }>('/api/plans').catch(() => ({ plans: [] }))).plans
  const first = (kind: Plan['kind']) => String(plansOf(kind)[0]?.id ?? NONE)
  form.value.hosting = first('hosting')
  form.value.reseller = first('reseller')
}

async function create() {
  busy.value = true
  formError.value = ''
  const id = (value: string) => (value === NONE ? null : Number(value))
  try {
    const r = await post<{ account: Account; password: string }>('/api/accounts', {
      username: form.value.username,
      email: form.value.email,
      password: form.value.password || undefined,
      role: form.value.role,
      hostingPlanId: id(form.value.hosting),
      vpsPlanId: id(form.value.vps),
      resellerPlanId: form.value.role === 'reseller' ? id(form.value.reseller) : null,
      mustChangePassword: form.value.mustChange,
      note: form.value.note,
    })
    creating.value = false
    created.value = { username: r.account.username, password: r.password }
    await reload()
  } catch (failure) {
    formError.value = messageOf(failure)
  }
  busy.value = false
}
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">{{ t('Accounts') }}</h2>
      <p class="text-muted-foreground mt-1 text-sm">
        {{ isAdmin ? t('Every reseller and customer on this server.') : t('Your customers. They see only their own account.') }}
      </p>
    </div>
    <Button @click="openNew"><UserPlusIcon data-icon="inline-start" /> {{ tab === 'reseller' ? t('New reseller') : t('New account') }}</Button>
  </div>

  <div class="flex flex-wrap items-center justify-between gap-3">
    <Tabs v-if="isAdmin" v-model="tab">
      <TabsList>
        <TabsTrigger value="user" class="px-3">{{ t('Users') }}</TabsTrigger>
        <TabsTrigger value="reseller" class="px-3">{{ t('Resellers') }}</TabsTrigger>
      </TabsList>
    </Tabs>
    <InputGroup class="w-full sm:w-72">
      <InputGroupAddon><SearchIcon /></InputGroupAddon>
      <InputGroupInput v-model="q" :placeholder="t('Search name, email or plan…')" />
    </InputGroup>
  </div>

  <LoadError :message="data ? '' : error" />

  <Card v-if="data && shown.length" class="py-0">
    <CardContent class="px-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="pl-4">{{ t('Username') }}</TableHead>
            <TableHead v-if="isAdmin && tab === 'user'">{{ t('Reseller') }}</TableHead>
            <TableHead>{{ tab === 'reseller' ? t('Reseller plan') : t('Plans') }}</TableHead>
            <TableHead v-if="tab === 'reseller'">{{ t('Accounts') }}</TableHead>
            <TableHead class="hidden pr-4 md:table-cell">{{ t('Last sign-in') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="a in shown" :key="a.id" class="cursor-pointer" @click="router.push(`/accounts/${a.id}`)">
            <TableCell class="pl-4">
              <div class="flex flex-wrap items-center gap-1.5">
                <RouterLink :to="`/accounts/${a.id}`" class="font-mono font-medium hover:underline" @click.stop>{{ a.username }}</RouterLink>
                <Badge v-if="a.suspended" variant="destructive">{{ t('Suspended') }}</Badge>
                <Badge v-if="a.mustChangePassword" variant="outline">{{ t('Temporary password') }}</Badge>
              </div>
              <p v-if="a.email" class="text-muted-foreground truncate text-xs">{{ a.email }}</p>
            </TableCell>
            <TableCell v-if="isAdmin && tab === 'user'" class="font-mono text-sm">
              {{ a.owner?.role === 'reseller' ? a.owner.username : '—' }}
            </TableCell>
            <TableCell>
              <div class="flex flex-wrap gap-1">
                <Badge v-if="a.resellerPlan" variant="secondary">{{ a.resellerPlan.name }}</Badge>
                <Badge v-if="a.hostingPlan" variant="secondary">{{ t('Hosting') }}: {{ a.hostingPlan.name }}</Badge>
                <Badge v-if="a.vpsPlan" variant="secondary">{{ t('VPS') }}: {{ a.vpsPlan.name }}</Badge>
              </div>
            </TableCell>
            <TableCell v-if="tab === 'reseller'" class="font-mono">{{ a.accounts }}</TableCell>
            <TableCell class="text-muted-foreground hidden pr-4 md:table-cell">{{ a.lastLoginAt ? ago(a.lastLoginAt) : t('never') }}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </CardContent>
  </Card>
  <Card v-else-if="data">
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><UsersIcon /></EmptyMedia>
        <EmptyTitle>{{ q ? t('No account matches') : tab === 'reseller' ? t('No resellers yet') : t('No accounts yet') }}</EmptyTitle>
        <EmptyDescription>{{ t('Each account gets a plan that sets what it may use.') }}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent v-if="!q"><Button @click="openNew"><UserPlusIcon data-icon="inline-start" /> {{ tab === 'reseller' ? t('New reseller') : t('New account') }}</Button></EmptyContent>
    </Empty>
  </Card>
  <Skeleton v-else-if="!error" class="h-64 rounded-xl" />

  <Dialog v-model:open="creating">
    <DialogContent class="max-h-[90svh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ form.role === 'reseller' ? t('New reseller') : t('New account') }}</DialogTitle>
        <DialogDescription>{{ t('The account signs in with this username and the password below.') }}</DialogDescription>
      </DialogHeader>
      <form id="new-account" class="flex flex-col gap-4" @submit.prevent="create">
        <div class="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel for="na-user">{{ t('Username') }}</FieldLabel>
            <Input id="na-user" class="font-mono" autocomplete="off" spellcheck="false" maxlength="16" :model-value="form.username" @update:model-value="(v) => (form.username = String(v).toLowerCase())" />
            <FieldDescription>{{ t('3 to 16 lowercase letters or digits.') }}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel for="na-email">{{ t('Email') }}</FieldLabel>
            <Input id="na-email" v-model="form.email" type="email" />
          </Field>
        </div>
        <Field>
          <FieldLabel for="na-pw">{{ t('Password') }}</FieldLabel>
          <Input id="na-pw" v-model="form.password" class="font-mono" autocomplete="new-password" :placeholder="t('Leave empty to generate one')" />
        </Field>
        <Field v-if="form.role === 'reseller'">
          <FieldLabel>{{ t('Reseller plan') }}</FieldLabel>
          <Select v-model="form.reseller">
            <SelectTrigger class="w-full"><SelectValue :placeholder="t('Choose a plan')" /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="p in plansOf('reseller')" :key="p.id" :value="String(p.id)">{{ p.name }}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <div class="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel>{{ t('Hosting plan') }}</FieldLabel>
            <Select v-model="form.hosting">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="NONE">{{ t('No hosting') }}</SelectItem>
                <SelectItem v-for="p in plansOf('hosting')" :key="p.id" :value="String(p.id)">{{ p.name }}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>{{ t('VPS plan') }}</FieldLabel>
            <Select v-model="form.vps">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="NONE">{{ t('No VPS') }}</SelectItem>
                <SelectItem v-for="p in plansOf('vps')" :key="p.id" :value="String(p.id)">{{ p.name }}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <p v-if="form.role === 'reseller'" class="text-muted-foreground text-xs">{{ t('A reseller can also host its own sites with a hosting or VPS plan.') }}</p>
        <label class="flex items-center gap-2 text-sm">
          <Switch v-model="form.mustChange" /> {{ t('Ask for a new password at first sign-in') }}
        </label>
        <Field>
          <FieldLabel for="na-note">{{ t('Note (only you see it)') }}</FieldLabel>
          <Input id="na-note" v-model="form.note" maxlength="500" />
        </Field>
        <FieldError v-if="formError">{{ formError }}</FieldError>
      </form>
      <DialogFooter>
        <Button variant="outline" @click="creating = false">{{ t('Cancel') }}</Button>
        <Button type="submit" form="new-account" :disabled="busy || form.username.length < 3">
          <Spinner v-if="busy" data-icon="inline-start" /> {{ t('Create') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <SecretDialog
    :title="t('{u} can sign in', { u: created?.username ?? '' })"
    :description="t('Give them this password. It is not shown again.')"
    :secret="created?.password ?? null"
    @close="created = null"
  />
</template>
