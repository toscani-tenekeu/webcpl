<script setup lang="ts">
import { BanIcon, CheckIcon, ChevronRightIcon, KeyRoundIcon, LogInIcon, ShieldOffIcon, Trash2Icon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import ConfirmDialog from '@/components/app/ConfirmDialog.vue'
import LimitsSummary from '@/components/app/LimitsSummary.vue'
import SecretDialog from '@/components/app/SecretDialog.vue'
import UsageBars from '@/components/app/UsageBars.vue'
import LoadError from '@/components/LoadError.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useResource } from '@/composables/useResource'
import { refreshSession, user as me } from '@/composables/useSession'
import { api, messageOf, post } from '@/lib/api'
import { ago, date } from '@/lib/format'
import { t } from '@/lib/i18n'
import type { Account, Plan, ResellerUsage } from '@/lib/types'

const route = useRoute()
const router = useRouter()
const id = computed(() => Number(route.params.id))
const { data, error, reload } = useResource<{ account: Account; usage: ResellerUsage | null; customers: Account[] | null }>(() => `/api/accounts/${id.value}`)
const account = computed(() => data.value?.account)
const ROLE_LABEL = { admin: 'Administrator', reseller: 'Reseller', user: 'User' } as const

// Plans to choose from are the owner's: the admin's, or the reseller's.
const plans = ref<Plan[]>([])
const NONE = 'none'
const form = ref({ email: '', note: '', hosting: NONE, vps: NONE, reseller: NONE })
watch(account, async (a) => {
  if (!a) return
  form.value = {
    email: a.email,
    note: a.note,
    hosting: String(a.hostingPlan?.id ?? NONE),
    vps: String(a.vpsPlan?.id ?? NONE),
    reseller: String(a.resellerPlan?.id ?? NONE),
  }
  // The caller's own plans are the owner's plans when the caller owns the account; the admin editing a
  // reseller's customer keeps the current plans (moving between a reseller's plans is the reseller's job).
  if (a.owner?.id === me.value?.id) plans.value = (await api<{ plans: Plan[] }>('/api/plans').catch(() => ({ plans: [] }))).plans
}, { immediate: true })
const ownsAccount = computed(() => account.value?.owner?.id === me.value?.id)
const plansOf = (kind: Plan['kind']) => plans.value.filter((p) => p.kind === kind)

const saving = ref(false)
const saveError = ref('')
async function save() {
  saving.value = true
  saveError.value = ''
  const pid = (v: string) => (v === NONE ? null : Number(v))
  try {
    await api(`/api/accounts/${id.value}`, {
      method: 'PATCH',
      body: {
        email: form.value.email,
        note: form.value.note,
        ...(ownsAccount.value ? { hostingPlanId: pid(form.value.hosting), vpsPlanId: pid(form.value.vps) } : {}),
        ...(ownsAccount.value && account.value?.role === 'reseller' ? { resellerPlanId: pid(form.value.reseller) } : {}),
      },
    })
    toast.success(t('Saved'))
    await reload()
  } catch (failure) {
    saveError.value = messageOf(failure)
  }
  saving.value = false
}

async function act(path: string, done: string, body: unknown = {}) {
  try {
    await post(`/api/accounts/${id.value}/${path}`, body)
    toast.success(done)
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}

const password = ref<string | null>(null)
async function resetPassword() {
  try {
    password.value = (await post<{ password: string }>(`/api/accounts/${id.value}/reset-password`)).password
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}

async function loginAs() {
  try {
    await post(`/api/accounts/${id.value}/login-as`)
    await refreshSession()
    await router.push('/')
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}

const suspendOpen = ref(false)
const suspendReason = ref('')
const deleteOpen = ref(false)

</script>

<template>
  <LoadError :message="data ? '' : error" />
  <template v-if="account && data">
    <nav class="text-muted-foreground flex items-center gap-1 text-sm">
      <RouterLink to="/accounts" class="hover:text-foreground">{{ t('Accounts') }}</RouterLink>
      <ChevronRightIcon class="size-3.5" />
      <span class="text-foreground font-mono">{{ account.username }}</span>
    </nav>

    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="flex flex-wrap items-center gap-2 font-mono text-2xl font-semibold tracking-tight">
          {{ account.username }}
          <Badge variant="secondary" class="font-sans">{{ t(ROLE_LABEL[account.role]) }}</Badge>
          <Badge v-if="account.suspended" variant="destructive" class="font-sans">{{ t('Suspended') }}</Badge>
        </h2>
        <p class="text-muted-foreground mt-1 text-sm">
          {{ t('Created {d}', { d: date(account.createdAt) }) }} · {{ account.lastLoginAt ? t('last sign-in {t}', { t: ago(account.lastLoginAt) }) : t('never signed in') }}
          <template v-if="account.owner && account.owner.role === 'reseller'"> · {{ t('customer of {u}', { u: account.owner.username }) }}</template>
        </p>
        <p v-if="account.suspended && account.suspendedReason" class="text-destructive mt-1 text-sm">{{ account.suspendedReason }}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" @click="loginAs"><LogInIcon data-icon="inline-start" /> {{ t('Log in as') }}</Button>
        <Button variant="outline" @click="resetPassword"><KeyRoundIcon data-icon="inline-start" /> {{ t('Reset password') }}</Button>
        <Button v-if="account.totpEnabled" variant="outline" @click="act('reset-2fa', t('Two-factor sign-in turned off'))">
          <ShieldOffIcon data-icon="inline-start" /> {{ t('Reset 2FA') }}
        </Button>
        <Button v-if="account.suspended" variant="outline" @click="act('unsuspend', t('Account unsuspended'))"><CheckIcon data-icon="inline-start" /> {{ t('Unsuspend') }}</Button>
        <Button v-else variant="outline" @click="suspendReason = ''; suspendOpen = true"><BanIcon data-icon="inline-start" /> {{ t('Suspend') }}</Button>
      </div>
    </div>

    <div class="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{{ t('Details and plans') }}</CardTitle>
          <CardDescription v-if="!ownsAccount">{{ t('This account’s plans are set by its reseller.') }}</CardDescription>
        </CardHeader>
        <CardContent>
          <form class="flex flex-col gap-4" @submit.prevent="save">
            <Field>
              <FieldLabel for="ad-email">{{ t('Email') }}</FieldLabel>
              <Input id="ad-email" v-model="form.email" type="email" />
            </Field>
            <template v-if="ownsAccount">
              <Field v-if="account.role === 'reseller'">
                <FieldLabel>{{ t('Reseller plan') }}</FieldLabel>
                <Select v-model="form.reseller">
                  <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem v-for="p in plansOf('reseller')" :key="p.id" :value="String(p.id)">{{ p.name }}</SelectItem></SelectContent>
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
            </template>
            <template v-else>
              <div v-for="p in [account.hostingPlan && { kind: 'hosting' as const, label: 'Hosting', plan: account.hostingPlan }, account.vpsPlan && { kind: 'vps' as const, label: 'VPS', plan: account.vpsPlan }].filter(Boolean)" :key="p!.kind" class="rounded-md border p-3">
                <p class="text-sm font-medium">{{ t(p!.label) }}: {{ p!.plan.name }}</p>
                <LimitsSummary :kind="p!.kind" :limits="p!.plan.limits" />
              </div>
            </template>
            <Field>
              <FieldLabel for="ad-note">{{ t('Note (only you see it)') }}</FieldLabel>
              <Input id="ad-note" v-model="form.note" maxlength="500" />
            </Field>
            <FieldError v-if="saveError">{{ saveError }}</FieldError>
            <div><Button type="submit" :disabled="saving"><Spinner v-if="saving" data-icon="inline-start" /> {{ t('Save changes') }}</Button></div>
          </form>
        </CardContent>
      </Card>

      <Card v-if="account.role === 'reseller'">
        <CardHeader>
          <CardTitle>{{ t('Handed out') }}</CardTitle>
          <CardDescription>{{ t('What this reseller’s accounts may use in total, against its plan.') }}</CardDescription>
        </CardHeader>
        <CardContent><UsageBars v-if="data.usage" :usage="data.usage" /></CardContent>
      </Card>
    </div>

    <Card v-if="data.customers" class="gap-0 pb-0">
      <CardHeader class="pb-4"><CardTitle>{{ t('Customers') }} <span class="text-muted-foreground font-normal">· {{ data.customers.length }}</span></CardTitle></CardHeader>
      <CardContent class="border-t px-0">
        <p v-if="!data.customers.length" class="text-muted-foreground p-4 text-sm">{{ t('No customers yet.') }}</p>
        <Table v-else>
          <TableHeader>
            <TableRow><TableHead class="pl-4">{{ t('Username') }}</TableHead><TableHead>{{ t('Plans') }}</TableHead><TableHead class="pr-4">{{ t('Last sign-in') }}</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="c in data.customers" :key="c.id" class="cursor-pointer" @click="router.push(`/accounts/${c.id}`)">
              <TableCell class="pl-4 font-mono">{{ c.username }} <Badge v-if="c.suspended" variant="destructive" class="ml-1 font-sans">{{ t('Suspended') }}</Badge></TableCell>
              <TableCell class="text-sm">{{ [c.hostingPlan?.name, c.vpsPlan?.name].filter(Boolean).join(' · ') }}</TableCell>
              <TableCell class="text-muted-foreground pr-4">{{ c.lastLoginAt ? ago(c.lastLoginAt) : t('never') }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    <Card class="border-destructive/30">
      <CardHeader>
        <CardTitle class="flex items-center gap-2"><Trash2Icon class="size-4" /> {{ t('Delete account') }}</CardTitle>
        <CardDescription>
          {{ account.role === 'reseller' ? t('A reseller can be deleted once it has no customers left.') : t('The account and everything it owns are removed for good.') }}
        </CardDescription>
      </CardHeader>
      <CardContent><Button variant="destructive" @click="deleteOpen = true"><Trash2Icon data-icon="inline-start" /> {{ t('Delete…') }}</Button></CardContent>
    </Card>

    <SecretDialog
      :title="t('New temporary password')"
      :description="t('Give it to {u}. They choose their own at next sign-in. Their sessions were signed out.', { u: account.username })"
      :secret="password"
      @close="password = null"
    />
    <ConfirmDialog
      v-model:open="suspendOpen"
      :title="t('Suspend {u}?', { u: account.username })"
      :description="t('The account can no longer sign in. Its sites and VPS will be stopped once hosting is set up on this server.')"
      :action="t('Suspend')"
      destructive
      :confirm="() => act('suspend', t('Account suspended'), { reason: suspendReason })"
    >
      <Field>
        <FieldLabel for="suspend-reason">{{ t('Reason (shown to the account at sign-in)') }}</FieldLabel>
        <Input id="suspend-reason" v-model="suspendReason" maxlength="200" :placeholder="t('For example: unpaid invoice')" />
      </Field>
    </ConfirmDialog>
    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="t('Delete {u}?', { u: account.username })"
      :description="t('This cannot be undone.')"
      :word="account.username"
      :action="t('Delete account')"
      destructive
      :confirm="async () => { await api(`/api/accounts/${id}`, { method: 'DELETE', body: { confirm: account!.username } }); toast.success(t('{u} deleted', { u: account!.username })); await router.push('/accounts') }"
    />
  </template>
  <Skeleton v-else-if="!error" class="h-80 rounded-xl" />
</template>
