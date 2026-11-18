<script setup lang="ts">
import { PlusIcon, Trash2Icon } from '@lucide/vue'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { useResource } from '@/composables/useResource'
import { del, messageOf, post } from '@/lib/api'
import { t } from '@/lib/i18n'

const { data, reload } = useResource<{ ips: { ip: string; vps: { id: number; name: string; owner: string } | null }[] }>('/api/server/ips')
const input = ref('')
async function add() {
  try {
    await post('/api/server/ips', { ips: input.value })
    input.value = ''
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}
async function remove(ip: string) {
  try {
    await del(`/api/server/ips/${ip}`)
    await reload()
  } catch (failure) {
    toast.error(messageOf(failure))
  }
}
</script>

<template>
  <Card class="gap-0 pb-0">
    <CardHeader class="pb-4">
      <CardTitle>{{ t('Public IPv4 pool') }}</CardTitle>
      <CardDescription>{{ t('Extra addresses your provider routes to this server. Users take them for their VPS, up to their plan.') }}</CardDescription>
    </CardHeader>
    <CardContent class="flex flex-col gap-0 border-t px-0">
      <form class="flex gap-2 p-4" @submit.prevent="add">
        <Input v-model="input" class="max-w-md font-mono" placeholder="203.0.113.10, 203.0.113.11" />
        <Button type="submit" variant="outline" :disabled="!input.trim()"><PlusIcon data-icon="inline-start" /> {{ t('Add') }}</Button>
      </form>
      <Table v-if="data?.ips.length">
        <TableBody>
          <TableRow v-for="r in data.ips" :key="r.ip">
            <TableCell class="pl-4 font-mono">{{ r.ip }}</TableCell>
            <TableCell>
              <RouterLink v-if="r.vps" :to="`/vps/${r.vps.id}`" class="hover:underline">{{ r.vps.owner }} · {{ r.vps.name }}</RouterLink>
              <Badge v-else variant="secondary">{{ t('Free') }}</Badge>
            </TableCell>
            <TableCell class="w-12 pr-4"><Button size="icon-sm" variant="ghost" class="text-destructive" :disabled="!!r.vps" :aria-label="t('Delete')" @click="remove(r.ip)"><Trash2Icon /></Button></TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </CardContent>
  </Card>
</template>
