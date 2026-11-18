<script setup lang="ts">
import { KeyIcon, PlusIcon, Trash2Icon } from '@lucide/vue'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import ConfirmDialog from '@/components/app/ConfirmDialog.vue'
import SecretDialog from '@/components/app/SecretDialog.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useResource } from '@/composables/useResource'
import { del, messageOf, post } from '@/lib/api'
import { ago, date } from '@/lib/format'
import { t } from '@/lib/i18n'

interface Key { id: number; name: string; prefix: string; createdAt: number; lastUsedAt: number | null }

const { data, reload } = useResource<{ keys: Key[] }>('/api/account/api-keys')
const name = ref('')
const secret = ref<string | null>(null)
const removing = ref<Key | null>(null)

async function create() {
  try {
    const r = await post<{ key: string }>('/api/account/api-keys', { name: name.value })
    secret.value = r.key
    name.value = ''
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="flex items-center gap-2"><KeyIcon class="size-4" /> {{ t('API keys') }}</CardTitle>
      <CardDescription>{{ t('For billing systems and scripts. A key acts as you, with your permissions.') }}</CardDescription>
    </CardHeader>
    <CardContent class="flex flex-col gap-4">
      <form class="flex gap-2" @submit.prevent="create">
        <Input v-model="name" maxlength="60" :placeholder="t('Key name, like billing')" />
        <Button type="submit" variant="outline" :disabled="!name.trim()"><PlusIcon data-icon="inline-start" /> {{ t('Create key') }}</Button>
      </form>
      <ul v-if="data?.keys.length" class="divide-y rounded-md border">
        <li v-for="key in data.keys" :key="key.id" class="flex items-center gap-3 px-3 py-2 text-sm">
          <div class="min-w-0 flex-1">
            <p class="font-medium">{{ key.name }} <span class="text-muted-foreground font-mono text-xs">{{ key.prefix }}…</span></p>
            <p class="text-muted-foreground text-xs">
              {{ t('Created {d}', { d: date(key.createdAt) }) }} · {{ key.lastUsedAt ? t('used {t}', { t: ago(key.lastUsedAt) }) : t('never used') }}
            </p>
          </div>
          <Button variant="ghost" size="icon-sm" class="text-destructive" :aria-label="t('Delete')" @click="removing = key"><Trash2Icon /></Button>
        </li>
      </ul>
    </CardContent>
  </Card>
  <SecretDialog
    :title="t('Your new API key')"
    :description="t('Copy it now: it is not shown again. Send it as: Authorization: Bearer <key>')"
    :secret="secret"
    @close="secret = null"
  />
  <ConfirmDialog
    :open="!!removing"
    :title="t('Delete the key {n}?', { n: removing?.name ?? '' })"
    :description="t('Scripts using it stop working at once.')"
    :action="t('Delete key')"
    destructive
    :confirm="async () => { await del(`/api/account/api-keys/${removing!.id}`); await reload() }"
    @update:open="(v: boolean) => { if (!v) removing = null }"
  />
</template>
