<script setup lang="ts">
import { LockIcon, PlusIcon, SaveIcon, Trash2Icon, XIcon } from '@lucide/vue'
import { ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { api, messageOf, post } from '@/lib/api'
import { t } from '@/lib/i18n'
import type { Website } from '@/lib/types'

const props = defineProps<{ site: Website }>()
const emit = defineEmits<{ changed: [] }>()

const redirect = ref({ on: false, to: '', code: '301', keepPath: true })
const pages = ref<Record<string, string>>({ '403': '', '404': '', '500': '', '503': '' })
watch(() => props.site, (s) => {
  redirect.value = { on: !!s.redirect, to: s.redirect?.to ?? '', code: String(s.redirect?.code ?? 301), keepPath: s.redirect?.keepPath ?? true }
  pages.value = { '403': '', '404': '', '500': '', '503': '', ...s.errorPages }
}, { immediate: true })

const busy = ref('')
async function run(key: string, fn: () => Promise<unknown>, done: string) {
  busy.value = key
  try {
    await fn()
    toast.success(done)
    emit('changed')
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  busy.value = ''
}
const saveRedirect = () => run('redirect', () => api(`/api/domains/${props.site.id}/rules`, {
  method: 'PATCH', body: { redirect: redirect.value.on ? { to: redirect.value.to, code: Number(redirect.value.code), keepPath: redirect.value.keepPath } : null },
}), t('Saved'))
const savePages = () => run('pages', () => api(`/api/domains/${props.site.id}/rules`, { method: 'PATCH', body: { errorPages: pages.value } }), t('Saved'))

const guard = ref({ path: '', username: '', password: '' })
const addGuard = () => run('guard', async () => {
  await post(`/api/domains/${props.site.id}/protected`, guard.value)
  guard.value = { path: guard.value.path, username: '', password: '' }
}, t('Saved'))
const removeGuard = (path: string, username?: string) =>
  run(`rm-${path}-${username ?? ''}`, () => api(`/api/domains/${props.site.id}/protected`, { method: 'DELETE', body: { path, username } }), t('Removed'))
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>{{ t('Redirect') }}</CardTitle>
      <CardDescription>{{ t('Send every visitor of this website to another address, for example after a move.') }}</CardDescription>
    </CardHeader>
    <CardContent>
      <form class="flex flex-col gap-4" @submit.prevent="saveRedirect">
        <label class="flex items-center gap-2 text-sm"><Switch v-model="redirect.on" /> {{ t('Redirect this website') }}</label>
        <div v-if="redirect.on" class="grid gap-4 md:grid-cols-[1fr_12rem]">
          <Field>
            <FieldLabel for="r-to">{{ t('To') }}</FieldLabel>
            <Input id="r-to" v-model="redirect.to" class="font-mono" placeholder="https://www.example.com" />
          </Field>
          <Field>
            <FieldLabel>{{ t('Kind') }}</FieldLabel>
            <Select v-model="redirect.code">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="301">{{ t('Permanent (301)') }}</SelectItem><SelectItem value="302">{{ t('Temporary (302)') }}</SelectItem></SelectContent>
            </Select>
          </Field>
          <label class="flex items-center gap-2 text-sm md:col-span-2"><Switch v-model="redirect.keepPath" /> {{ t('Keep the rest of the address (/page?x=1)') }}</label>
        </div>
        <div><Button type="submit" :disabled="!!busy"><Spinner v-if="busy === 'redirect'" data-icon="inline-start" /><SaveIcon v-else data-icon="inline-start" /> {{ t('Save') }}</Button></div>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="flex items-center gap-2"><LockIcon class="size-4" /> {{ t('Protected folders') }}</CardTitle>
      <CardDescription>{{ t('Visitors must give a username and password to open these folders.') }}</CardDescription>
    </CardHeader>
    <CardContent class="flex flex-col gap-4">
      <div v-for="p in site.protected" :key="p.id" class="flex flex-wrap items-center gap-2 rounded-lg border p-3">
        <span class="font-mono text-sm">{{ p.path }}</span>
        <Badge v-for="u in p.users" :key="u" variant="secondary" class="gap-1 font-mono">
          {{ u }}
          <button type="button" :aria-label="t('Remove')" @click="removeGuard(p.path, u)"><XIcon class="size-3" /></button>
        </Badge>
        <Button size="icon-sm" variant="ghost" class="text-destructive ml-auto" :aria-label="t('Delete')" @click="removeGuard(p.path)"><Trash2Icon /></Button>
      </div>
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="addGuard">
        <Field class="w-48"><FieldLabel for="g-path">{{ t('Folder') }}</FieldLabel><Input id="g-path" v-model="guard.path" class="font-mono" placeholder="/admin" /></Field>
        <Field class="w-40"><FieldLabel for="g-user">{{ t('Username') }}</FieldLabel><Input id="g-user" v-model="guard.username" class="font-mono" autocomplete="off" /></Field>
        <Field class="w-48"><FieldLabel for="g-pass">{{ t('Password') }}</FieldLabel><Input id="g-pass" v-model="guard.password" type="password" autocomplete="new-password" /></Field>
        <Button type="submit" variant="outline" :disabled="!!busy || !guard.path || !guard.username || guard.password.length < 8">
          <Spinner v-if="busy === 'guard'" data-icon="inline-start" /><PlusIcon v-else data-icon="inline-start" /> {{ t('Add') }}
        </Button>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle>{{ t('Error pages') }}</CardTitle>
      <CardDescription>{{ t('Pages of this website to show instead of the default error messages.') }}</CardDescription>
    </CardHeader>
    <CardContent>
      <form class="flex flex-col gap-4" @submit.prevent="savePages">
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field v-for="code in ['403', '404', '500', '503']" :key="code">
            <FieldLabel :for="`ep-${code}`">{{ code }}</FieldLabel>
            <Input :id="`ep-${code}`" v-model="pages[code]" class="font-mono" :placeholder="`/${code}.html`" />
          </Field>
        </div>
        <FieldDescription>{{ t('Leave a field empty for the default page.') }}</FieldDescription>
        <div><Button type="submit" :disabled="!!busy"><Spinner v-if="busy === 'pages'" data-icon="inline-start" /><SaveIcon v-else data-icon="inline-start" /> {{ t('Save') }}</Button></div>
      </form>
    </CardContent>
  </Card>
</template>
