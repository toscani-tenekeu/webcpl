<script setup lang="ts">
import BackupSettings from '@/components/app/BackupSettings.vue'
import HostnameSsl from '@/components/app/HostnameSsl.vue'
import { SaveIcon } from '@lucide/vue'
import { ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import LoadError from '@/components/LoadError.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useResource } from '@/composables/useResource'
import { panelName } from '@/composables/useSession'
import { messageOf, put } from '@/lib/api'
import { t } from '@/lib/i18n'

type Settings = Record<'panel_name' | 'hostname' | 'nameserver1' | 'nameserver2' | 'support_email' | 'public_ip', string>
const { data, error } = useResource<{ settings: Settings }>('/api/settings')
const form = ref<Settings>({ panel_name: '', hostname: '', nameserver1: '', nameserver2: '', support_email: '', public_ip: '' })
watch(data, (d) => { if (d) form.value = { ...d.settings, panel_name: d.settings.panel_name || 'Webcpl' } }, { immediate: true })
const busy = ref(false)
const formError = ref('')

async function save() {
  busy.value = true
  formError.value = ''
  try {
    const r = await put<{ settings: Settings }>('/api/settings', form.value)
    panelName.value = r.settings.panel_name || 'Webcpl'
    toast.success(t('Settings saved'))
  } catch (failure) {
    formError.value = messageOf(failure)
  }
  busy.value = false
}
</script>

<template>
  <div>
    <h2 class="text-2xl font-semibold tracking-tight">{{ t('Panel settings') }}</h2>
    <p class="text-muted-foreground mt-1 text-sm">{{ t('How the panel presents itself. Everything works on the IP address until you set a hostname.') }}</p>
  </div>
  <LoadError :message="error" />
  <form v-if="data" class="flex max-w-3xl flex-col gap-5" @submit.prevent="save">
    <Card>
      <CardHeader><CardTitle>{{ t('Identity') }}</CardTitle></CardHeader>
      <CardContent class="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel for="s-name">{{ t('Panel name') }}</FieldLabel>
          <Input id="s-name" v-model="form.panel_name" maxlength="40" />
          <FieldDescription>{{ t('Shown on the sign-in page and in the sidebar.') }}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel for="s-mail">{{ t('Support email') }}</FieldLabel>
          <Input id="s-mail" v-model="form.support_email" type="email" />
        </Field>
      </CardContent>
    </Card>
    <Card>
      <CardHeader>
        <CardTitle>{{ t('Hostname and name servers') }}</CardTitle>
        <CardDescription>{{ t('Optional. Point the names at this server first; new DNS zones use these name servers.') }}</CardDescription>
      </CardHeader>
      <CardContent class="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel for="s-host">{{ t('Server hostname') }}</FieldLabel>
          <Input id="s-host" v-model="form.hostname" class="font-mono" placeholder="panel.example.com" />
        </Field>
        <Field>
          <FieldLabel for="s-ip">{{ t('Server public IP') }}</FieldLabel>
          <Input id="s-ip" v-model="form.public_ip" class="font-mono" placeholder="203.0.113.10" />
          <FieldDescription>{{ t('Websites and DNS records point to this address.') }}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel for="s-ns1">{{ t('Name server 1') }}</FieldLabel>
          <Input id="s-ns1" v-model="form.nameserver1" class="font-mono" placeholder="ns1.example.com" />
        </Field>
        <Field>
          <FieldLabel for="s-ns2">{{ t('Name server 2') }}</FieldLabel>
          <Input id="s-ns2" v-model="form.nameserver2" class="font-mono" placeholder="ns2.example.com" />
        </Field>
      </CardContent>
    </Card>
    <FieldError v-if="formError">{{ formError }}</FieldError>
    <div><Button type="submit" :disabled="busy"><Spinner v-if="busy" data-icon="inline-start" /><SaveIcon v-else data-icon="inline-start" /> {{ t('Save settings') }}</Button></div>
  </form>
  <HostnameSsl />
  <BackupSettings />
</template>
