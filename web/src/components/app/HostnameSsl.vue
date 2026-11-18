<script setup lang="ts">
import { LockIcon } from '@lucide/vue'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import ConfirmDialog from '@/components/app/ConfirmDialog.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useResource } from '@/composables/useResource'
import { messageOf, post, put } from '@/lib/api'
import { date } from '@/lib/format'
import { t } from '@/lib/i18n'

interface Status { certificate: { installed: boolean; subject?: string; expiresAt?: number }; hostname: string | null; tls: boolean; port: number }
const { data, reload } = useResource<Status>('/api/server/ssl')
const issuing = ref(false)
const tlsOpen = ref(false)

async function issue() {
  issuing.value = true
  try {
    await post('/api/server/ssl')
    toast.success(t('Certificate installed'))
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  issuing.value = false
}
async function setTls() {
  const on = !data.value!.tls
  await put('/api/server/ssl/panel', { on })
  // The panel restarts on the other scheme: go there once it is back.
  const target = `${on ? 'https' : 'http'}://${on ? data.value!.hostname : location.hostname}:${data.value!.port}/settings`
  setTimeout(() => (location.href = target), 4000)
}
</script>

<template>
  <Card v-if="data">
    <CardHeader>
      <CardTitle class="flex items-center gap-2"><LockIcon class="size-4" /> {{ t('Hostname certificate') }}</CardTitle>
      <CardDescription>
        <template v-if="data.certificate.installed">{{ t('{h}: valid until {d}, renewed automatically. Mail uses it too.', { h: data.certificate.subject ?? '', d: date(data.certificate.expiresAt ?? 0) }) }}</template>
        <template v-else>{{ t('A free Let’s Encrypt certificate for the server hostname, for the panel and for mail. The hostname must point to this server.') }}</template>
      </CardDescription>
    </CardHeader>
    <CardContent class="flex flex-col gap-4">
      <div>
        <Button :variant="data.certificate.installed ? 'outline' : 'default'" :disabled="issuing || !data.hostname" @click="issue">
          <Spinner v-if="issuing" data-icon="inline-start" /><LockIcon v-else data-icon="inline-start" />
          {{ data.certificate.installed ? t('Get it again') : t('Get a certificate for {h}', { h: data.hostname ?? t('the hostname') }) }}
        </Button>
        <p v-if="!data.hostname" class="text-muted-foreground mt-2 text-xs">{{ t('Set the server hostname above first.') }}</p>
      </div>
      <label class="flex items-center gap-2 text-sm" :class="data.certificate.installed ? '' : 'opacity-50'">
        <Switch :model-value="data.tls" :disabled="!data.certificate.installed" @update:model-value="tlsOpen = true" />
        {{ t('Serve the panel over HTTPS on port {p}', { p: data.port }) }}
      </label>
    </CardContent>
  </Card>
  <ConfirmDialog v-model:open="tlsOpen" :title="data?.tls ? t('Turn off HTTPS for the panel?') : t('Turn on HTTPS for the panel?')"
    :description="data?.tls ? t('The panel restarts and answers on http:// again.') : t('The panel restarts and answers on https://{h}:{p} only. Plain http:// stops working.', { h: data?.hostname ?? '', p: data?.port ?? 7777 })"
    :action="t('Restart the panel')" :confirm="setTls" />
</template>
