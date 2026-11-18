<script setup lang="ts">
import { DicesIcon, ExternalLinkIcon, ForwardIcon, KeyRoundIcon, MailIcon, PlusIcon, Trash2Icon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import ConfirmDialog from '@/components/app/ConfirmDialog.vue'
import LoadError from '@/components/LoadError.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useResource } from '@/composables/useResource'
import { api, del, messageOf, post } from '@/lib/api'
import { bytes } from '@/lib/format'
import { t } from '@/lib/i18n'
import { randomPassword } from '@/lib/password'

interface Autoreply { enabled: boolean; subject: string; message: string; start: string | null; end: string | null }
interface Mailbox { id: number; domainId: number; address: string; quotaMb: number; usedBytes: number; autoreply: Autoreply | null; spamToJunk: boolean }
interface Forwarder { id: number; domainId: number; source: string; destinations: string[] }
interface MailData {
  domains: { id: number; name: string }[]
  mailboxes: Mailbox[]
  forwarders: Forwarder[]
  limit: number | null
  settings: { host: string; imap: number; pop3: number; smtp: number; submission: number }
  webmail: string
}
const { data, error, reload } = useResource<MailData>('/api/mail', 30000)
const full = computed(() => !!data.value && data.value.limit !== null && data.value.mailboxes.length >= data.value.limit)

// ---- new mailbox / forwarder ----
const dialog = ref<'mailbox' | 'forwarder' | null>(null)
const dialogOpen = computed({ get: () => !!dialog.value, set: (v) => { if (!v) dialog.value = null } })
const form = ref({ domainId: '', local: '', password: '', quotaMb: 1024, destinations: '' })
const busy = ref(false)
const formError = ref('')
function open(kind: 'mailbox' | 'forwarder') {
  form.value = { domainId: String(data.value?.domains[0]?.id ?? ''), local: '', password: randomPassword(16), quotaMb: 1024, destinations: '' }
  formError.value = ''
  dialog.value = kind
}
const domainName = computed(() => data.value?.domains.find((d) => String(d.id) === form.value.domainId)?.name ?? '')
async function submit() {
  busy.value = true
  formError.value = ''
  try {
    if (dialog.value === 'mailbox') {
      await post('/api/mail/mailboxes', { domainId: Number(form.value.domainId), local: form.value.local, password: form.value.password, quotaMb: form.value.quotaMb })
      toast.success(t('{a} is ready. Its password: {p}', { a: `${form.value.local}@${domainName.value}`, p: form.value.password }), { duration: 20000 })
    } else {
      await post('/api/mail/forwarders', { domainId: Number(form.value.domainId), local: form.value.local, destinations: form.value.destinations })
      toast.success(t('Forwarder added'))
    }
    dialog.value = null
    await reload()
  } catch (failure) {
    formError.value = messageOf(failure)
  }
  busy.value = false
}

// ---- edit mailbox ----
const editing = ref<Mailbox | null>(null)
const editOpen = computed({ get: () => !!editing.value, set: (v) => { if (!v) editing.value = null } })
const edit = ref({ password: '', quotaMb: 0, spamToJunk: true, reply: { enabled: false, subject: '', message: '', start: '', end: '' } })
function openEdit(m: Mailbox) {
  const r = m.autoreply
  edit.value = { password: '', quotaMb: m.quotaMb, spamToJunk: m.spamToJunk, reply: { enabled: !!r?.enabled, subject: r?.subject ?? '', message: r?.message ?? '', start: r?.start ?? '', end: r?.end ?? '' } }
  editing.value = m
}
async function saveEdit() {
  busy.value = true
  try {
    await api(`/api/mail/mailboxes/${editing.value!.id}`, { method: 'PATCH', body: {
      quotaMb: edit.value.quotaMb,
      spamToJunk: edit.value.spamToJunk,
      autoreply: { ...edit.value.reply, start: edit.value.reply.start || null, end: edit.value.reply.end || null },
      ...(edit.value.password ? { password: edit.value.password } : {}),
    } })
    toast.success(t('Saved'))
    editing.value = null
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  busy.value = false
}

const removing = ref<Mailbox | null>(null)
const removeOpen = computed({ get: () => !!removing.value, set: (v) => { if (!v) removing.value = null } })
async function removeForwarder(f: Forwarder) {
  try {
    await del(`/api/mail/forwarders/${f.id}`)
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">{{ t('Mail') }}</h2>
      <p class="text-muted-foreground mt-1 text-sm">{{ t('Mailboxes and forwarders for your domains. Messages are stored in your home folder.') }}</p>
    </div>
    <div v-if="data && data.domains.length" class="flex gap-2">
      <Button variant="outline" as-child><a :href="data.webmail" target="_blank" rel="noreferrer"><ExternalLinkIcon data-icon="inline-start" /> {{ t('Webmail') }}</a></Button>
      <Button variant="outline" @click="open('forwarder')"><ForwardIcon data-icon="inline-start" /> {{ t('Forwarder') }}</Button>
      <Button :disabled="full" @click="open('mailbox')"><PlusIcon data-icon="inline-start" /> {{ t('Mailbox') }}</Button>
    </div>
  </div>
  <LoadError :message="data ? '' : error" />

  <template v-if="data">
    <Card v-if="!data.domains.length">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><MailIcon /></EmptyMedia>
          <EmptyTitle>{{ t('Add a domain first') }}</EmptyTitle>
          <EmptyDescription>{{ t('Mail works for the domains in Websites.') }}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </Card>
    <template v-else>
      <Card class="gap-0 pb-0">
        <CardHeader class="pb-4">
          <CardTitle>{{ t('Mailboxes') }}</CardTitle>
          <CardDescription>{{ t('{n} of {m} used.', { n: data.mailboxes.length, m: data.limit ?? '∞' }) }}</CardDescription>
        </CardHeader>
        <CardContent class="border-t px-0">
          <p v-if="!data.mailboxes.length" class="text-muted-foreground p-4 text-sm">{{ t('No mailboxes yet.') }}</p>
          <Table v-else>
            <TableHeader><TableRow><TableHead class="pl-4">{{ t('Address') }}</TableHead><TableHead class="w-64">{{ t('Space') }}</TableHead><TableHead class="w-24 pr-4" /></TableRow></TableHeader>
            <TableBody>
              <TableRow v-for="m in data.mailboxes" :key="m.id">
                <TableCell class="pl-4 font-mono">{{ m.address }}</TableCell>
                <TableCell>
                  <div class="flex flex-col gap-1">
                    <span class="font-mono text-xs">{{ bytes(m.usedBytes) }} / {{ m.quotaMb ? `${m.quotaMb} MB` : '∞' }}</span>
                    <Progress v-if="m.quotaMb" :model-value="Math.min(100, (m.usedBytes / (m.quotaMb * 1048576)) * 100)" class="h-1" />
                  </div>
                </TableCell>
                <TableCell class="pr-4">
                  <div class="flex justify-end gap-0.5">
                    <Button size="icon-sm" variant="ghost" :aria-label="t('Edit')" @click="openEdit(m)"><KeyRoundIcon /></Button>
                    <Button size="icon-sm" variant="ghost" class="text-destructive" :aria-label="t('Delete')" @click="removing = m"><Trash2Icon /></Button>
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card class="gap-0 pb-0">
        <CardHeader class="pb-4">
          <CardTitle>{{ t('Forwarders') }}</CardTitle>
          <CardDescription>{{ t('Send what arrives at an address on to others. A mailbox that forwards keeps its copy.') }}</CardDescription>
        </CardHeader>
        <CardContent class="border-t px-0">
          <p v-if="!data.forwarders.length" class="text-muted-foreground p-4 text-sm">{{ t('No forwarders yet.') }}</p>
          <Table v-else>
            <TableBody>
              <TableRow v-for="f in data.forwarders" :key="f.id">
                <TableCell class="pl-4 font-mono">{{ f.source.startsWith('@') ? t('Any other address at {d}', { d: f.source.slice(1) }) : f.source }}</TableCell>
                <TableCell class="text-muted-foreground font-mono text-xs">→ {{ f.destinations.join(', ') }}</TableCell>
                <TableCell class="w-12 pr-4"><Button size="icon-sm" variant="ghost" class="text-destructive" :aria-label="t('Delete')" @click="removeForwarder(f)"><Trash2Icon /></Button></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{{ t('Mail app settings') }}</CardTitle>
          <CardDescription>{{ t('Sign in with the full address and its password.') }}</CardDescription>
          <CardAction><Button variant="outline" size="sm" as-child><a :href="data.webmail" target="_blank" rel="noreferrer">{{ t('Open webmail') }}</a></Button></CardAction>
        </CardHeader>
        <CardContent class="grid gap-3 text-sm sm:grid-cols-3">
          <div><p class="text-muted-foreground">{{ t('Server') }}</p><p class="font-mono">{{ data.settings.host }}</p></div>
          <div><p class="text-muted-foreground">{{ t('Incoming') }}</p><p class="font-mono">IMAP {{ data.settings.imap }} · POP3 {{ data.settings.pop3 }} (SSL)</p></div>
          <div><p class="text-muted-foreground">{{ t('Outgoing') }}</p><p class="font-mono">SMTP {{ data.settings.smtp }} (SSL) · {{ data.settings.submission }} (STARTTLS)</p></div>
        </CardContent>
      </Card>
    </template>
  </template>
  <Skeleton v-else-if="!error" class="h-64 rounded-xl" />

  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ dialog === 'mailbox' ? t('New mailbox') : t('New forwarder') }}</DialogTitle>
        <DialogDescription>{{ dialog === 'mailbox' ? t('An address with its own storage, for mail apps and webmail.') : t('Leave the name empty to catch every address that has no mailbox.') }}</DialogDescription>
      </DialogHeader>
      <form v-if="data" id="mail-form" class="flex flex-col gap-4" @submit.prevent="submit">
        <Field>
          <FieldLabel for="mail-local">{{ t('Address') }}</FieldLabel>
          <div class="flex items-center gap-2">
            <Input id="mail-local" v-model="form.local" class="font-mono" :placeholder="dialog === 'mailbox' ? 'info' : t('(any)')" autocomplete="off" />
            <span class="text-muted-foreground">@</span>
            <Select v-model="form.domainId">
              <SelectTrigger class="w-48"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem v-for="d in data.domains" :key="d.id" :value="String(d.id)">{{ d.name }}</SelectItem></SelectContent>
            </Select>
          </div>
        </Field>
        <template v-if="dialog === 'mailbox'">
          <Field>
            <FieldLabel for="mail-pass">{{ t('Password') }}</FieldLabel>
            <InputGroup>
              <InputGroupInput id="mail-pass" v-model="form.password" class="font-mono" autocomplete="new-password" />
              <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" :aria-label="t('Generate')" @click="form.password = randomPassword(16)"><DicesIcon /></InputGroupButton></InputGroupAddon>
            </InputGroup>
          </Field>
          <Field>
            <FieldLabel for="mail-quota">{{ t('Space (MB)') }}</FieldLabel>
            <Input id="mail-quota" v-model.number="form.quotaMb" type="number" min="0" />
            <FieldDescription>{{ t('0 for no limit besides your disk space.') }}</FieldDescription>
          </Field>
        </template>
        <Field v-else>
          <FieldLabel for="mail-dest">{{ t('Forward to') }}</FieldLabel>
          <Input id="mail-dest" v-model="form.destinations" class="font-mono" placeholder="me@example.com, team@example.com" />
        </Field>
        <FieldError v-if="formError">{{ formError }}</FieldError>
      </form>
      <DialogFooter>
        <Button variant="outline" @click="dialog = null">{{ t('Cancel') }}</Button>
        <Button type="submit" form="mail-form" :disabled="busy"><Spinner v-if="busy" data-icon="inline-start" /> {{ t('Create') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="editOpen">
    <DialogContent v-if="editing" class="max-h-[92svh] overflow-y-auto sm:max-w-md">
      <DialogHeader><DialogTitle class="font-mono">{{ editing.address }}</DialogTitle><DialogDescription>{{ t('Leave the password empty to keep it.') }}</DialogDescription></DialogHeader>
      <form id="mail-edit" class="flex flex-col gap-4" @submit.prevent="saveEdit">
        <Field>
          <FieldLabel for="edit-pass">{{ t('New password') }}</FieldLabel>
          <InputGroup>
            <InputGroupInput id="edit-pass" v-model="edit.password" class="font-mono" autocomplete="new-password" />
            <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" :aria-label="t('Generate')" @click="edit.password = randomPassword(16)"><DicesIcon /></InputGroupButton></InputGroupAddon>
          </InputGroup>
        </Field>
        <Field>
          <FieldLabel for="edit-quota">{{ t('Space (MB)') }}</FieldLabel>
          <Input id="edit-quota" v-model.number="edit.quotaMb" type="number" min="0" />
        </Field>
        <label class="flex items-center gap-2 text-sm"><Switch v-model="edit.spamToJunk" /> {{ t('Put spam in the Junk folder') }}</label>
        <div class="flex flex-col gap-3 rounded-lg border p-3">
          <label class="flex items-center gap-2 text-sm font-medium"><Switch v-model="edit.reply.enabled" /> {{ t('Automatic reply') }}</label>
          <template v-if="edit.reply.enabled">
            <Input v-model="edit.reply.subject" :placeholder="t('Subject, like: Away until Monday')" />
            <Textarea v-model="edit.reply.message" class="min-h-24" :placeholder="t('The reply people get, once a day at most.')" />
            <div class="grid grid-cols-2 gap-3">
              <Field><FieldLabel for="ar-start">{{ t('From') }}</FieldLabel><Input id="ar-start" v-model="edit.reply.start" type="date" /></Field>
              <Field><FieldLabel for="ar-end">{{ t('Until') }}</FieldLabel><Input id="ar-end" v-model="edit.reply.end" type="date" /></Field>
            </div>
          </template>
        </div>
      </form>
      <DialogFooter>
        <Button variant="outline" @click="editing = null">{{ t('Cancel') }}</Button>
        <Button type="submit" form="mail-edit" :disabled="busy"><Spinner v-if="busy" data-icon="inline-start" /> {{ t('Save') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <ConfirmDialog
    v-model:open="removeOpen"
    :title="t('Delete {n}?', { n: removing?.address ?? '' })"
    :description="t('The mailbox and every message in it are removed for good.')"
    :word="removing?.address"
    :action="t('Delete mailbox')"
    destructive
    :confirm="async () => { await api(`/api/mail/mailboxes/${removing!.id}`, { method: 'DELETE', body: { confirm: removing!.address } }); await reload() }"
  />
</template>
