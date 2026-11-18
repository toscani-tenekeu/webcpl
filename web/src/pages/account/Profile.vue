<script setup lang="ts">
import { MailIcon } from '@lucide/vue'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { user } from '@/composables/useSession'
import { api, messageOf } from '@/lib/api'
import { t } from '@/lib/i18n'
import type { Account } from '@/lib/types'

const email = ref(user.value?.email ?? '')
const busy = ref(false)
const error = ref('')

async function save() {
  busy.value = true
  error.value = ''
  try {
    const r = await api<{ user: Account }>('/api/account', { method: 'PATCH', body: { email: email.value } })
    user.value = r.user
    toast.success(t('Saved'))
  } catch (failure) {
    error.value = messageOf(failure)
  }
  busy.value = false
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="flex items-center gap-2"><MailIcon class="size-4" /> {{ t('Contact email') }}</CardTitle>
      <CardDescription>{{ t('Where notices about this account are sent.') }}</CardDescription>
    </CardHeader>
    <CardContent>
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="save">
        <Field class="min-w-64 flex-1">
          <FieldLabel for="me-email">{{ t('Email') }}</FieldLabel>
          <Input id="me-email" v-model="email" type="email" autocomplete="email" />
          <FieldError v-if="error">{{ error }}</FieldError>
        </Field>
        <Button type="submit" :disabled="busy"><Spinner v-if="busy" data-icon="inline-start" /> {{ t('Save') }}</Button>
      </form>
    </CardContent>
  </Card>
</template>
