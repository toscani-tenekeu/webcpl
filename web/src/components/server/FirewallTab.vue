<script setup lang="ts">
import { PlusIcon, ShieldIcon, Trash2Icon } from '@lucide/vue'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import ConfirmDialog from '@/components/app/ConfirmDialog.vue'
import LoadError from '@/components/LoadError.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { useResource } from '@/composables/useResource'
import { api, messageOf, post, put } from '@/lib/api'
import { t } from '@/lib/i18n'

interface Status { installed: boolean; active: boolean; rules: string[] }
const { data, error } = useResource<Status>('/api/server/firewall')
const form = ref({ action: 'allow', port: '', proto: 'tcp', from: '' })
const busy = ref(false)
const toggleOpen = ref(false)

async function run(fn: () => Promise<Status>, done?: string) {
  busy.value = true
  try {
    data.value = await fn()
    if (done) toast.success(done)
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  busy.value = false
}
const add = () => run(async () => {
  const r = await post<Status>('/api/server/firewall/rules', form.value)
  form.value.port = ''
  form.value.from = ''
  return r
}, t('Rule added'))
const remove = (rule: string) => run(() => api<Status>('/api/server/firewall/rules', { method: 'DELETE', body: { rule } }))
const toggle = () => run(() => put<Status>('/api/server/firewall', { on: !data.value!.active }))
</script>

<template>
  <LoadError :message="data ? '' : error" />
  <template v-if="data">
    <Card v-if="!data.installed"><CardContent class="text-muted-foreground text-sm">{{ t('UFW is not installed on this server.') }}</CardContent></Card>
    <template v-else>
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2"><ShieldIcon class="size-4" /> {{ t('Firewall') }} <Badge :variant="data.active ? 'default' : 'secondary'">{{ data.active ? t('On') : t('Off') }}</Badge></CardTitle>
          <CardDescription>{{ t('UFW. SSH and the panel always stay open, so you cannot lock yourself out.') }}</CardDescription>
          <CardAction><Button :variant="data.active ? 'outline' : 'default'" :disabled="busy" @click="toggleOpen = true">{{ data.active ? t('Turn off') : t('Turn on') }}</Button></CardAction>
        </CardHeader>
      </Card>
      <Card class="gap-0 pb-0">
        <CardHeader class="pb-4">
          <CardTitle>{{ t('Rules') }}</CardTitle>
          <CardDescription>{{ t('Everything else coming in is blocked while the firewall is on.') }}</CardDescription>
        </CardHeader>
        <CardContent class="border-t px-0">
          <p v-if="!data.rules.length" class="text-muted-foreground p-4 text-sm">{{ t('No rules yet.') }}</p>
          <Table v-else>
            <TableBody>
              <TableRow v-for="r in data.rules" :key="r">
                <TableCell class="pl-4"><Badge :variant="r.startsWith('deny') || r.startsWith('reject') ? 'destructive' : 'secondary'">{{ r.split(' ')[0] }}</Badge></TableCell>
                <TableCell class="font-mono text-sm">{{ r.split(' ').slice(1).join(' ') }}</TableCell>
                <TableCell class="w-12 pr-4"><Button size="icon-sm" variant="ghost" class="text-destructive" :disabled="busy" :aria-label="t('Delete')" @click="remove(r)"><Trash2Icon /></Button></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{{ t('Add a rule') }}</CardTitle></CardHeader>
        <CardContent>
          <form class="flex flex-wrap items-end gap-3" @submit.prevent="add">
            <Field class="w-32">
              <FieldLabel>{{ t('Action') }}</FieldLabel>
              <Select v-model="form.action"><SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="allow">{{ t('Allow') }}</SelectItem><SelectItem value="deny">{{ t('Block') }}</SelectItem></SelectContent></Select>
            </Field>
            <Field class="w-36"><FieldLabel for="fw-port">{{ t('Port') }}</FieldLabel><Input id="fw-port" v-model="form.port" class="font-mono" placeholder="8080 or 3000:3100" /></Field>
            <Field class="w-28">
              <FieldLabel>{{ t('Protocol') }}</FieldLabel>
              <Select v-model="form.proto"><SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="tcp">TCP</SelectItem><SelectItem value="udp">UDP</SelectItem></SelectContent></Select>
            </Field>
            <Field class="w-56"><FieldLabel for="fw-from">{{ t('From (optional)') }}</FieldLabel><Input id="fw-from" v-model="form.from" class="font-mono" placeholder="203.0.113.0/24" /></Field>
            <Button type="submit" :disabled="busy || !form.port"><Spinner v-if="busy" data-icon="inline-start" /><PlusIcon v-else data-icon="inline-start" /> {{ t('Add') }}</Button>
          </form>
        </CardContent>
      </Card>
    </template>
  </template>
  <Skeleton v-else-if="!error" class="h-48 rounded-xl" />
  <ConfirmDialog v-model:open="toggleOpen" :title="data?.active ? t('Turn off the firewall?') : t('Turn on the firewall?')"
    :description="data?.active ? t('Every port becomes reachable.') : t('Only the ports in the rules, SSH and the panel stay reachable. Check that websites (80, 443) and mail ports are allowed.')"
    :action="data?.active ? t('Turn off') : t('Turn on')" :confirm="toggle" />
</template>
