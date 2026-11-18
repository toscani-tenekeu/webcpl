<script setup lang="ts">
import { PlayIcon, PlugIcon, SaveIcon } from '@lucide/vue'
import { ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { useResource } from '@/composables/useResource'
import { messageOf, post, put } from '@/lib/api'
import { t } from '@/lib/i18n'

interface Remote { type: 'none' | 'sftp' | 's3'; host?: string; port?: number; user?: string; password?: string; passwordSet?: boolean; endpoint?: string; accessKey?: string; secretKey?: string; secretKeySet?: boolean; region?: string; path?: string }
interface Settings { schedule: 'off' | 'daily' | 'weekly'; hour: number; keep: number; remote: Remote }
const { data, reload } = useResource<{ settings: Settings }>('/api/server/backups')
const form = ref<Settings>({ schedule: 'daily', hour: 3, keep: 7, remote: { type: 'none' } })
watch(data, (d) => { if (d) form.value = JSON.parse(JSON.stringify(d.settings)) }, { immediate: true })
const busy = ref('')

async function save() {
  busy.value = 'save'
  try {
    await put('/api/server/backups', { ...form.value, hour: Number(form.value.hour), keep: Number(form.value.keep) })
    toast.success(t('Saved'))
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  busy.value = ''
}
async function action(path: string, done: string) {
  busy.value = path
  try {
    const r = await post<{ accounts?: number }>(`/api/server/backups/${path}`)
    toast.success(t(done, { n: r.accounts ?? 0 }))
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  busy.value = ''
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>{{ t('Backups') }}</CardTitle>
      <CardDescription>{{ t('Every hosting account is backed up on this schedule, to /var/backups/webcpl and to off-site storage if set.') }}</CardDescription>
      <CardAction><Button variant="outline" size="sm" :disabled="!!busy" @click="action('run', 'Backups started for {n} accounts')"><PlayIcon data-icon="inline-start" /> {{ t('Back up all now') }}</Button></CardAction>
    </CardHeader>
    <CardContent>
      <form class="flex flex-col gap-5" @submit.prevent="save">
        <div class="grid gap-4 sm:grid-cols-3">
          <Field>
            <FieldLabel>{{ t('Schedule') }}</FieldLabel>
            <Select v-model="form.schedule">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">{{ t('Off') }}</SelectItem>
                <SelectItem value="daily">{{ t('Every day') }}</SelectItem>
                <SelectItem value="weekly">{{ t('Every Sunday') }}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field><FieldLabel for="b-hour">{{ t('Hour') }}</FieldLabel><Input id="b-hour" v-model.number="form.hour" type="number" min="0" max="23" /></Field>
          <Field><FieldLabel for="b-keep">{{ t('Keep') }}</FieldLabel><Input id="b-keep" v-model.number="form.keep" type="number" min="1" max="90" /><FieldDescription>{{ t('Scheduled backups per account.') }}</FieldDescription></Field>
        </div>
        <Field>
          <FieldLabel>{{ t('Off-site copy') }}</FieldLabel>
          <Select v-model="form.remote.type">
            <SelectTrigger class="w-full sm:w-64"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{{ t('None') }}</SelectItem>
              <SelectItem value="sftp">SFTP</SelectItem>
              <SelectItem value="s3">{{ t('S3-compatible storage') }}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <div v-if="form.remote.type === 'sftp'" class="grid gap-4 sm:grid-cols-2">
          <Field><FieldLabel for="r-host">{{ t('Server') }}</FieldLabel><Input id="r-host" v-model="form.remote.host" class="font-mono" placeholder="backup.example.com" /></Field>
          <Field><FieldLabel for="r-port">{{ t('Port') }}</FieldLabel><Input id="r-port" v-model.number="form.remote.port" type="number" /></Field>
          <Field><FieldLabel for="r-user">{{ t('User') }}</FieldLabel><Input id="r-user" v-model="form.remote.user" class="font-mono" /></Field>
          <Field><FieldLabel for="r-pass">{{ t('Password') }}</FieldLabel><Input id="r-pass" v-model="form.remote.password" type="password" :placeholder="form.remote.passwordSet ? t('Unchanged') : ''" autocomplete="new-password" /></Field>
          <Field class="sm:col-span-2"><FieldLabel for="r-path">{{ t('Folder') }}</FieldLabel><Input id="r-path" v-model="form.remote.path" class="font-mono" placeholder="backups/webcpl" /></Field>
        </div>
        <div v-if="form.remote.type === 's3'" class="grid gap-4 sm:grid-cols-2">
          <Field><FieldLabel for="r-end">{{ t('Endpoint') }}</FieldLabel><Input id="r-end" v-model="form.remote.endpoint" class="font-mono" placeholder="https://s3.example.com" /></Field>
          <Field><FieldLabel for="r-region">{{ t('Region') }}</FieldLabel><Input id="r-region" v-model="form.remote.region" class="font-mono" placeholder="us-east-1" /></Field>
          <Field><FieldLabel for="r-ak">{{ t('Access key') }}</FieldLabel><Input id="r-ak" v-model="form.remote.accessKey" class="font-mono" /></Field>
          <Field><FieldLabel for="r-sk">{{ t('Secret key') }}</FieldLabel><Input id="r-sk" v-model="form.remote.secretKey" type="password" :placeholder="form.remote.secretKeySet ? t('Unchanged') : ''" autocomplete="new-password" /></Field>
          <Field class="sm:col-span-2"><FieldLabel for="r-bucket">{{ t('Bucket and folder') }}</FieldLabel><Input id="r-bucket" v-model="form.remote.path" class="font-mono" placeholder="my-bucket/webcpl" /></Field>
        </div>
        <div class="flex gap-2">
          <Button type="submit" :disabled="!!busy"><Spinner v-if="busy === 'save'" data-icon="inline-start" /><SaveIcon v-else data-icon="inline-start" /> {{ t('Save') }}</Button>
          <Button v-if="data?.settings.remote.type !== 'none'" type="button" variant="outline" :disabled="!!busy" @click="action('test', 'The off-site storage answers.')">
            <Spinner v-if="busy === 'test'" data-icon="inline-start" /><PlugIcon v-else data-icon="inline-start" /> {{ t('Test off-site storage') }}
          </Button>
        </div>
      </form>
    </CardContent>
  </Card>
</template>
