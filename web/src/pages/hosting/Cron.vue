<script setup lang="ts">
import { ClockIcon, PlusIcon, Trash2Icon } from '@lucide/vue'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import LoadError from '@/components/LoadError.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useResource } from '@/composables/useResource'
import { del, messageOf, post } from '@/lib/api'
import { t } from '@/lib/i18n'

interface Job { id: number; schedule: string; command: string }
const { data, error, reload } = useResource<{ jobs: Job[] }>('/api/cron')
const PRESETS = [
  { value: '*/5 * * * *', label: 'Every 5 minutes' },
  { value: '0 * * * *', label: 'Every hour' },
  { value: '0 3 * * *', label: 'Every day at 03:00' },
  { value: '0 3 * * 1', label: 'Every Monday at 03:00' },
  { value: '0 3 1 * *', label: 'The 1st of each month' },
]
const schedule = ref('0 * * * *')
const command = ref('')
const busy = ref(false)

async function add() {
  busy.value = true
  try {
    await post('/api/cron', { schedule: schedule.value, command: command.value })
    command.value = ''
    toast.success(t('Cron job added'))
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  busy.value = false
}

async function remove(job: Job) {
  try {
    await del(`/api/cron/${job.id}`)
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}
</script>

<template>
  <div>
    <h2 class="text-2xl font-semibold tracking-tight">{{ t('Cron jobs') }}</h2>
    <p class="text-muted-foreground mt-1 text-sm">{{ t('Commands that run on a schedule, as your account.') }}</p>
  </div>
  <LoadError :message="data ? '' : error" />

  <Card>
    <CardHeader><CardTitle>{{ t('New cron job') }}</CardTitle><CardDescription>{{ t('Times are in the server’s time zone.') }}</CardDescription></CardHeader>
    <CardContent>
      <form class="grid gap-4 md:grid-cols-[16rem_1fr_auto] md:items-end" @submit.prevent="add">
        <Field>
          <FieldLabel for="cron-schedule">{{ t('When') }}</FieldLabel>
          <Input id="cron-schedule" v-model="schedule" class="font-mono" />
          <Select :model-value="''" @update:model-value="(v) => (schedule = String(v))">
            <SelectTrigger size="sm" class="w-full"><SelectValue :placeholder="t('Common schedules')" /></SelectTrigger>
            <SelectContent><SelectItem v-for="p in PRESETS" :key="p.value" :value="p.value">{{ t(p.label) }}</SelectItem></SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel for="cron-command">{{ t('Command') }}</FieldLabel>
          <Input id="cron-command" v-model="command" class="font-mono" placeholder="php ~/domains/example.com/public_html/cron.php" />
          <FieldDescription>{{ t('minute hour day month weekday, or @daily, @hourly…') }}</FieldDescription>
        </Field>
        <Button type="submit" :disabled="busy || !command.trim()"><Spinner v-if="busy" data-icon="inline-start" /><PlusIcon v-else data-icon="inline-start" /> {{ t('Add') }}</Button>
      </form>
    </CardContent>
  </Card>

  <Card v-if="data" class="py-0">
    <CardContent class="px-0">
      <p v-if="!data.jobs.length" class="text-muted-foreground flex items-center gap-2 p-6 text-sm"><ClockIcon class="size-4" /> {{ t('No cron jobs yet.') }}</p>
      <Table v-else>
        <TableHeader><TableRow><TableHead class="pl-4">{{ t('When') }}</TableHead><TableHead>{{ t('Command') }}</TableHead><TableHead class="w-12 pr-4" /></TableRow></TableHeader>
        <TableBody>
          <TableRow v-for="job in data.jobs" :key="job.id">
            <TableCell class="pl-4 font-mono text-sm whitespace-nowrap">{{ job.schedule }}</TableCell>
            <TableCell class="max-w-0 w-full truncate font-mono text-xs">{{ job.command }}</TableCell>
            <TableCell class="pr-4"><Button size="icon-sm" variant="ghost" class="text-destructive" :aria-label="t('Delete')" @click="remove(job)"><Trash2Icon /></Button></TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </CardContent>
  </Card>
  <Skeleton v-else-if="!error" class="h-32 rounded-xl" />
</template>
