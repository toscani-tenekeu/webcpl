<script setup lang="ts">
import type { Limits, PlanKind } from '@shared/limits'
import { LayersIcon, PencilIcon, PlusIcon, Trash2Icon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import ConfirmDialog from '@/components/app/ConfirmDialog.vue'
import LimitsForm from '@/components/app/LimitsForm.vue'
import LimitsSummary from '@/components/app/LimitsSummary.vue'
import LoadError from '@/components/LoadError.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useResource } from '@/composables/useResource'
import { user } from '@/composables/useSession'
import { api, del, messageOf, post } from '@/lib/api'
import { t } from '@/lib/i18n'
import type { Plan } from '@/lib/types'

const { data, error, reload } = useResource<{ plans: Plan[] }>('/api/plans')
const isAdmin = computed(() => user.value?.role === 'admin')
const kinds = computed<{ id: PlanKind; label: string; text: string }[]>(() => [
  { id: 'hosting', label: 'Hosting', text: 'Websites, databases, mail and files on this server.' },
  { id: 'vps', label: 'VPS', text: 'LXC containers with their own system and root access.' },
  ...(isAdmin.value ? [{ id: 'reseller' as const, label: 'Reseller', text: 'What a reseller may hand out to its own customers, in total.' }] : []),
])
const kind = ref<PlanKind>('hosting')
const current = computed(() => kinds.value.find((k) => k.id === kind.value)!)
const plans = computed(() => (data.value?.plans ?? []).filter((p) => p.kind === kind.value))

// ---- create and edit ----
const editing = ref<{ id: number | null; name: string; limits: Limits } | null>(null)
const busy = ref(false)
const formError = ref('')

function openNew() {
  editing.value = { id: null, name: '', limits: {} }
  formError.value = ''
}
function openEdit(plan: Plan) {
  editing.value = { id: plan.id, name: plan.name, limits: { ...plan.limits } }
  formError.value = ''
}

async function save() {
  if (!editing.value) return
  busy.value = true
  formError.value = ''
  try {
    const body = { kind: kind.value, name: editing.value.name, limits: editing.value.limits }
    if (editing.value.id) await api(`/api/plans/${editing.value.id}`, { method: 'PATCH', body })
    else await post('/api/plans', body)
    toast.success(t('Plan saved'))
    editing.value = null
    await reload()
  } catch (failure) {
    formError.value = messageOf(failure)
  }
  busy.value = false
}

const removing = ref<Plan | null>(null)
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">{{ t('Plans') }}</h2>
      <p class="text-muted-foreground mt-1 text-sm">{{ t(current.text) }}</p>
    </div>
    <Button @click="openNew"><PlusIcon data-icon="inline-start" /> {{ t('New plan') }}</Button>
  </div>

  <Tabs v-model="kind">
    <TabsList>
      <TabsTrigger v-for="k in kinds" :key="k.id" :value="k.id" class="px-3">
        {{ t(k.label) }}
        <Badge v-if="data" variant="secondary" class="h-4 px-1.5 text-[10px]">{{ data.plans.filter((p) => p.kind === k.id).length }}</Badge>
      </TabsTrigger>
    </TabsList>
  </Tabs>

  <LoadError :message="data ? '' : error" />

  <div v-if="data && plans.length" class="grid gap-4 md:grid-cols-2">
    <Card v-for="plan in plans" :key="plan.id">
      <CardHeader>
        <CardTitle>{{ plan.name }}</CardTitle>
        <CardDescription>{{ t('{n} account(s)', { n: plan.accounts }) }}</CardDescription>
        <CardAction class="flex gap-1">
          <Button variant="ghost" size="icon-sm" :aria-label="t('Edit')" @click="openEdit(plan)"><PencilIcon /></Button>
          <Button variant="ghost" size="icon-sm" class="text-destructive" :aria-label="t('Delete')" @click="removing = plan"><Trash2Icon /></Button>
        </CardAction>
      </CardHeader>
      <CardContent><LimitsSummary :kind="plan.kind" :limits="plan.limits" /></CardContent>
    </Card>
  </div>
  <Card v-else-if="data">
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><LayersIcon /></EmptyMedia>
        <EmptyTitle>{{ t('No {k} plans yet', { k: t(current.label).toLowerCase() }) }}</EmptyTitle>
        <EmptyDescription>{{ t('A plan sets what an account may use. Make one, then give it to accounts.') }}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent><Button @click="openNew"><PlusIcon data-icon="inline-start" /> {{ t('New plan') }}</Button></EmptyContent>
    </Empty>
  </Card>
  <div v-else-if="!error" class="grid gap-4 md:grid-cols-2"><Skeleton v-for="n in 4" :key="n" class="h-32 rounded-xl" /></div>

  <Dialog :open="!!editing" @update:open="(v: boolean) => { if (!v) editing = null }">
    <DialogContent v-if="editing" class="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{{ editing.id ? t('Edit {n}', { n: editing.name }) : t('New {k} plan', { k: t(current.label).toLowerCase() }) }}</DialogTitle>
        <DialogDescription>
          {{ editing.id ? t('Changes apply to every account on this plan.') : t('Leave a limit on Unlimited to allow any amount.') }}
        </DialogDescription>
      </DialogHeader>
      <form id="plan-form" class="flex flex-col gap-5" @submit.prevent="save">
        <Field>
          <FieldLabel for="plan-name">{{ t('Name') }}</FieldLabel>
          <Input id="plan-name" v-model="editing.name" maxlength="60" required />
        </Field>
        <LimitsForm v-model="editing.limits" :kind="kind" />
        <FieldError v-if="formError">{{ formError }}</FieldError>
      </form>
      <DialogFooter>
        <Button variant="outline" @click="editing = null">{{ t('Cancel') }}</Button>
        <Button type="submit" form="plan-form" :disabled="busy || !editing.name.trim()">
          <Spinner v-if="busy" data-icon="inline-start" /> {{ t('Save plan') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <ConfirmDialog
    :open="!!removing"
    :title="t('Delete the plan {n}?', { n: removing?.name ?? '' })"
    :description="removing?.accounts ? t('{n} account(s) still use it. Move them to another plan first.', { n: removing.accounts }) : t('The plan is removed. No account uses it.')"
    :action="t('Delete plan')"
    destructive
    :confirm="async () => { await del(`/api/plans/${removing!.id}`); await reload() }"
    @update:open="(v: boolean) => { if (!v) removing = null }"
  />
</template>
