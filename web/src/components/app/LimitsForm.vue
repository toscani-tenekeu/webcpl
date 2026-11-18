<script setup lang="ts">
import { LIMITS, type Limits, type PlanKind } from '@shared/limits'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { t } from '@/lib/i18n'

const props = defineProps<{ kind: PlanKind }>()
const model = defineModel<Limits>({ required: true })

const set = (key: string, value: number | boolean | null) => (model.value = { ...model.value, [key]: value })
const unlimited = (key: string) => model.value[key] === null || model.value[key] === undefined
</script>

<template>
  <div class="grid gap-x-6 gap-y-4 sm:grid-cols-2">
    <template v-for="field in LIMITS[props.kind]" :key="field.key">
      <Field v-if="field.type === 'flag'" orientation="horizontal" class="sm:col-span-2">
        <Switch :id="`lim-${field.key}`" :model-value="model[field.key] === true" @update:model-value="(v) => set(field.key, v)" />
        <div>
          <FieldLabel :for="`lim-${field.key}`">{{ t(field.label) }}</FieldLabel>
          <FieldDescription v-if="field.hint">{{ t(field.hint) }}</FieldDescription>
        </div>
      </Field>
      <Field v-else>
        <div class="flex items-center justify-between gap-2">
          <FieldLabel :for="`lim-${field.key}`">
            {{ t(field.label) }}<span v-if="field.unit" class="text-muted-foreground font-normal"> ({{ t(field.unit) }})</span>
          </FieldLabel>
          <label class="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Checkbox :model-value="unlimited(field.key)" @update:model-value="(on) => set(field.key, on === true ? null : 0)" />
            {{ t('Unlimited') }}
          </label>
        </div>
        <Input
          :id="`lim-${field.key}`"
          :model-value="unlimited(field.key) ? '' : String(model[field.key])"
          :disabled="unlimited(field.key)"
          :placeholder="t('Unlimited')"
          inputmode="numeric"
          class="font-mono"
          @update:model-value="(v) => set(field.key, Number(String(v).replace(/\D/g, '')) || 0)"
        />
        <FieldDescription v-if="field.hint">{{ t(field.hint) }}</FieldDescription>
      </Field>
    </template>
  </div>
</template>
