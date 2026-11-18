<script setup lang="ts">
import { ShieldBanIcon } from '@lucide/vue'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import LoadError from '@/components/LoadError.vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useResource } from '@/composables/useResource'
import { messageOf, post } from '@/lib/api'
import { t } from '@/lib/i18n'

interface Status { installed: boolean; running?: boolean; jails: { name: string; failed: number; banned: string[]; total: number }[] }
const { data, error } = useResource<Status>('/api/server/fail2ban', 30_000)
const LABEL: Record<string, string> = { sshd: 'SSH', webcpl: 'Panel sign-in', 'postfix-sasl': 'Sending mail', dovecot: 'Reading mail' }
const busy = ref('')
async function unban(ip: string) {
  busy.value = ip
  try {
    data.value = await post<Status>('/api/server/fail2ban/unban', { ip })
    toast.success(t('{ip} can connect again', { ip }))
  } catch (failure) {
    toast.error(messageOf(failure))
  }
  busy.value = ''
}
</script>

<template>
  <LoadError :message="data ? '' : error" />
  <template v-if="data">
    <Card v-if="!data.installed || !data.running"><CardContent class="text-muted-foreground text-sm">{{ t('Fail2ban is not running on this server.') }}</CardContent></Card>
    <template v-else>
      <p class="text-muted-foreground text-sm">{{ t('Fail2ban blocks an address for an hour after 5 failed sign-ins in 10 minutes.') }}</p>
      <div class="grid gap-5 md:grid-cols-2">
        <Card v-for="j in data.jails" :key="j.name">
          <CardHeader>
            <CardTitle class="flex items-center gap-2"><ShieldBanIcon class="size-4" /> {{ t(LABEL[j.name] ?? j.name) }}</CardTitle>
            <CardDescription>{{ t('{b} blocked now · {t} in total · {f} recent failures', { b: j.banned.length, t: j.total, f: j.failed }) }}</CardDescription>
          </CardHeader>
          <CardContent>
            <p v-if="!j.banned.length" class="text-muted-foreground text-sm">{{ t('Nobody is blocked.') }}</p>
            <ul v-else class="flex flex-col gap-1.5">
              <li v-for="ip in j.banned" :key="ip" class="flex items-center justify-between gap-2">
                <span class="font-mono text-sm">{{ ip }}</span>
                <Button size="sm" variant="outline" :disabled="busy === ip" @click="unban(ip)">{{ t('Unblock') }}</Button>
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </template>
  </template>
  <Skeleton v-else-if="!error" class="h-48 rounded-xl" />
</template>
