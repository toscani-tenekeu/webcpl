<script setup lang="ts">
import { DownloadIcon, RefreshCwIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { useResource } from '@/composables/useResource'
import { messageOf, post } from '@/lib/api'
import { t } from '@/lib/i18n'

interface Job { state: string; result: string; log: string }
const { data, reload } = useResource<{ system: Job; webcpl: Job }>('/api/server/updates', (d) => (d && [d.system, d.webcpl].some((j) => j.state === 'active' || j.state === 'activating') ? 3000 : false))
const check = ref<{ packages: { name: string; version: string; security: boolean }[]; rebootRequired: boolean } | null>(null)
const checking = ref(false)
const running = (j?: Job) => j?.state === 'active' || j?.state === 'activating'
const security = computed(() => check.value?.packages.filter((p) => p.security).length ?? 0)

async function runCheck() {
  checking.value = true
  try {
    check.value = await post('/api/server/updates/check')
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  checking.value = false
}
async function start(kind: 'system' | 'webcpl') {
  try {
    await post('/api/server/updates/start', { kind })
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>Webcpl</CardTitle>
      <CardDescription>{{ t('Gets the latest Webcpl and restarts the panel. Sites and mail keep running.') }}</CardDescription>
      <CardAction><Button :disabled="running(data?.webcpl)" @click="start('webcpl')"><Spinner v-if="running(data?.webcpl)" data-icon="inline-start" /><DownloadIcon v-else data-icon="inline-start" /> {{ t('Update Webcpl') }}</Button></CardAction>
    </CardHeader>
    <CardContent v-if="data?.webcpl.log">
      <pre class="bg-muted max-h-56 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">{{ data.webcpl.log }}</pre>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle>{{ t('System packages') }}</CardTitle>
      <CardDescription>{{ t('Security and bug fixes for the operating system and the services Webcpl runs.') }}</CardDescription>
      <CardAction class="flex gap-2">
        <Button variant="outline" :disabled="checking" @click="runCheck"><Spinner v-if="checking" data-icon="inline-start" /><RefreshCwIcon v-else data-icon="inline-start" /> {{ t('Check') }}</Button>
        <Button :disabled="running(data?.system)" @click="start('system')"><Spinner v-if="running(data?.system)" data-icon="inline-start" /><DownloadIcon v-else data-icon="inline-start" /> {{ t('Install updates') }}</Button>
      </CardAction>
    </CardHeader>
    <CardContent class="flex flex-col gap-3">
      <Alert v-if="check?.rebootRequired">
        <AlertTitle>{{ t('A restart is needed') }}</AlertTitle>
        <AlertDescription>{{ t('Some updates take effect after the server restarts. Choose a quiet moment.') }}</AlertDescription>
      </Alert>
      <template v-if="check">
        <p class="text-sm">{{ check.packages.length ? t('{n} packages can be updated, {s} of them for security.', { n: check.packages.length, s: security }) : t('Everything is up to date.') }}</p>
        <div v-if="check.packages.length" class="flex max-h-48 flex-wrap gap-1.5 overflow-auto">
          <Badge v-for="p in check.packages" :key="p.name" :variant="p.security ? 'destructive' : 'secondary'" class="font-mono">{{ p.name }}</Badge>
        </div>
      </template>
      <pre v-if="data?.system.log" class="bg-muted max-h-56 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">{{ data.system.log }}</pre>
    </CardContent>
  </Card>
</template>
