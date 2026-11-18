<script setup lang="ts">
import { KeyRoundIcon, PlusIcon, Trash2Icon } from '@lucide/vue'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useResource } from '@/composables/useResource'
import { del, messageOf, post } from '@/lib/api'
import { date } from '@/lib/format'
import { t } from '@/lib/i18n'

interface Key { id: number; name: string; type: string; fingerprint: string; createdAt: number }
const { data } = useResource<{ keys: Key[] }>('/api/ssh-keys')
const form = ref({ name: '', key: '' })
const busy = ref(false)
async function add() {
  busy.value = true
  try {
    data.value = await post('/api/ssh-keys', form.value)
    form.value = { name: '', key: '' }
    toast.success(t('Key added'))
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  busy.value = false
}
async function remove(k: Key) {
  try {
    data.value = await del(`/api/ssh-keys/${k.id}`)
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="flex items-center gap-2"><KeyRoundIcon class="size-4" /> {{ t('SSH keys') }}</CardTitle>
      <CardDescription>{{ t('Sign in to SFTP and SSH with a key instead of your password.') }}</CardDescription>
    </CardHeader>
    <CardContent class="flex flex-col gap-4">
      <ul v-if="data?.keys.length" class="flex flex-col gap-2">
        <li v-for="k in data.keys" :key="k.id" class="flex items-center gap-3 rounded-lg border p-3">
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium">{{ k.name }}</p>
            <p class="text-muted-foreground truncate font-mono text-xs">{{ k.type }} {{ k.fingerprint }} · {{ date(k.createdAt) }}</p>
          </div>
          <Button size="icon-sm" variant="ghost" class="text-destructive" :aria-label="t('Delete')" @click="remove(k)"><Trash2Icon /></Button>
        </li>
      </ul>
      <form class="flex flex-col gap-2" @submit.prevent="add">
        <Input v-model="form.name" :placeholder="t('Name, like: My laptop')" />
        <Textarea v-model="form.key" class="h-20 font-mono text-xs" placeholder="ssh-ed25519 AAAA… me@laptop" />
        <div><Button type="submit" variant="outline" :disabled="busy || !form.key.trim()"><Spinner v-if="busy" data-icon="inline-start" /><PlusIcon v-else data-icon="inline-start" /> {{ t('Add key') }}</Button></div>
      </form>
    </CardContent>
  </Card>
</template>
