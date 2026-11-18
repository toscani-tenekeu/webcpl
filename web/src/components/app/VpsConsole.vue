<script setup lang="ts">
import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { RotateCwIcon } from '@lucide/vue'
import { onBeforeUnmount, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { t } from '@/lib/i18n'

const props = defineProps<{ id: number }>()
const box = ref<HTMLDivElement>()
const state = ref<'connecting' | 'open' | 'closed'>('connecting')
const attempt = ref(0)
let cleanup: (() => void) | null = null

function connect() {
  cleanup?.()
  cleanup = null
  if (!box.value) return
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13.5,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#0f1115', foreground: '#e6e6e6' },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(box.value)
  fit.fit()
  state.value = 'connecting'
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/api/vps/${props.id}/console?cols=${term.cols}&rows=${term.rows}`)
  ws.binaryType = 'arraybuffer'
  const decoder = new TextDecoder()
  ws.onopen = () => {
    state.value = 'open'
    term.focus()
  }
  ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : decoder.decode(new Uint8Array(e.data), { stream: true }))
  ws.onclose = () => {
    state.value = 'closed'
    term.write(`\r\n\x1b[2m${t('Session closed.')}\x1b[0m\r\n`)
  }
  const input = term.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: 'i', d })))
  const resize = term.onResize(({ cols, rows }) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: 'r', c: cols, r: rows })))
  const observer = new ResizeObserver(() => {
    try {
      fit.fit()
    } catch {}
  })
  observer.observe(box.value)
  cleanup = () => {
    observer.disconnect()
    input.dispose()
    resize.dispose()
    ws.onclose = null
    ws.close()
    term.dispose()
  }
}

watch([() => props.id, attempt, box], connect, { flush: 'post' })
onBeforeUnmount(() => cleanup?.())
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex min-h-8 items-center justify-between gap-2">
      <span class="text-muted-foreground flex items-center gap-2 text-sm">
        <span class="size-2 rounded-full" :class="state === 'open' ? 'bg-emerald-500' : state === 'connecting' ? 'animate-pulse bg-amber-500' : 'bg-muted-foreground/50'" />
        {{ state === 'open' ? t('Connected as root.') : state === 'connecting' ? t('Connecting…') : t('Disconnected.') }}
      </span>
      <Button v-if="state === 'closed'" size="sm" variant="outline" @click="attempt++"><RotateCwIcon data-icon="inline-start" /> {{ t('Reconnect') }}</Button>
    </div>
    <div class="overflow-hidden rounded-xl border bg-[#0f1115] p-2">
      <div ref="box" class="h-[min(70vh,560px)] w-full" />
    </div>
  </div>
</template>
